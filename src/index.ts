import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

dotenv.config();

class AppError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

class ValidationError extends AppError {
  constructor(message: string) {
    super(400, 'VALIDATION_ERROR', message);
    this.name = 'ValidationError';
  }
}

class NotFoundError extends AppError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

class ExternalServiceError extends AppError {
  constructor(message: string, statusCode: number = 502) {
    super(statusCode, 'EXTERNAL_SERVICE_ERROR', message);
    this.name = 'ExternalServiceError';
  }
}

class ConfigurationError extends AppError {
  constructor(message: string) {
    super(503, 'CONFIGURATION_ERROR', message);
    this.name = 'ConfigurationError';
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const USDA_API_BASE = 'https://api.nal.usda.gov/fdc/v1';

app.use(cors());
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'Rate limit exceeded',
    message: 'Too many requests from this IP, please try again after 15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/foods', limiter);

interface FoodSearchParams {
  type?: string;
  limit?: string;
}

interface USDASearchResponse {
  foods?: Array<{
    fdcId: number;
    description: string;
    foodNutrients?: Array<{
      nutrientName: string;
      value: number;
      unitName: string;
    }>;
    brandName?: string;
    brandOwner?: string;
    servingSize?: number;
    servingSizeUnit?: string;
    householdServingFullText?: string;
  }>;
  totalHits?: number;
}

interface FormattedFood {
  id: number;
  description: string;
  brandName: string | null;
  servingSize: number | null;
  servingSizeUnit: string | null;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
}

interface USDAFetchResult {
  foods: FormattedFood[];
  totalResults: number;
}

const NUTRIENT_NAMES = {
  calories: ['Energy', 'Energy (Atwater General Factors)', 'Energy (Atwater Specific Factors)'],
  protein: ['Protein'],
  carbs: ['Carbohydrate, by difference', 'Carbohydrates'],
  fat: ['Total lipid (fat)', 'Total fat (NLEA)']
};

function extractNutrient(nutrients: Array<{ nutrientName: string; value: number; unitName: string }> | undefined, searchNames: string[]): number | null {
  if (!nutrients) return null;
  
  const found = nutrients.find(n => 
    searchNames.some(name => n.nutrientName.toLowerCase().includes(name.toLowerCase()))
  );
  
  return found ? found.value : null;
}

async function fetchUSDAFoods(query: string, limit: number): Promise<USDAFetchResult> {
  const apiKey = process.env.USDA_API_KEY;
  if (!apiKey) {
    throw new ConfigurationError('USDA API key is not configured. Please set USDA_API_KEY environment variable.');
  }

  const searchUrl = new URL(`${USDA_API_BASE}/foods/search`);
  searchUrl.searchParams.append('query', query);
  searchUrl.searchParams.append('pageSize', limit.toString());
  searchUrl.searchParams.append('api_key', apiKey);

  let response: globalThis.Response;
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    
    response = await fetch(searchUrl.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
  } catch (fetchError) {
    if (fetchError instanceof Error) {
      if (fetchError.name === 'AbortError') {
        throw new ExternalServiceError(
          'Request to USDA API timed out after 10 seconds. The service may be experiencing high load.',
          504
        );
      }
      
      if (fetchError.message.includes('ECONNREFUSED') || fetchError.message.includes('ENOTFOUND')) {
        throw new ExternalServiceError(
          'Unable to connect to USDA API. The service may be down or unreachable.',
          503
        );
      }
      
      if (fetchError.message.includes('ETIMEDOUT') || fetchError.message.includes('ECONNRESET')) {
        throw new ExternalServiceError(
          'Network error occurred while connecting to USDA API. Please try again later.',
          504
        );
      }
    }
    
    throw new ExternalServiceError(
      `Network error occurred: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`,
      502
    );
  }

  if (!response.ok) {
    let errorMessage: string;
    let errorStatus: number;
    
    try {
      const errorData = await response.json() as { message?: string; error?: string };
      errorMessage = errorData?.message || errorData?.error || `USDA API returned status ${response.status}`;
    } catch {
      errorMessage = `USDA API returned status ${response.status}: ${response.statusText}`;
    }
    
    switch (response.status) {
      case 400:
        errorStatus = 400;
        errorMessage = `Invalid request to USDA API: ${errorMessage}`;
        break;
      case 401:
      case 403:
        errorStatus = 503;
        errorMessage = 'USDA API authentication failed. Please check your API key configuration.';
        break;
      case 404:
        errorStatus = 502;
        errorMessage = 'USDA API endpoint not found. The API may have changed.';
        break;
      case 429:
        errorStatus = 503;
        errorMessage = 'Rate limit exceeded on USDA API. Please try again later.';
        break;
      case 500:
      case 502:
      case 503:
      case 504:
        errorStatus = 502;
        errorMessage = `USDA API is experiencing issues (${response.status}). Please try again later.`;
        break;
      default:
        errorStatus = 502;
    }
    
    throw new ExternalServiceError(errorMessage, errorStatus);
  }

  let data: USDASearchResponse;
  
  try {
    data = await response.json() as USDASearchResponse;
  } catch (parseError) {
    throw new ExternalServiceError(
      'Failed to parse response from USDA API. The API may be returning invalid JSON.',
      502
    );
  }

  if (!data || typeof data !== 'object') {
    throw new ExternalServiceError(
      'Invalid response structure from USDA API. Expected an object.',
      502
    );
  }

  if (!data.foods || data.foods.length === 0) {
    return {
      foods: [],
      totalResults: data.totalHits || 0
    };
  }

  const formattedFoods: FormattedFood[] = data.foods.map((food, index) => {
    try {
      return {
        id: food.fdcId,
        description: food.description,
        brandName: food.brandName || food.brandOwner || null,
        servingSize: food.servingSize || null,
        servingSizeUnit: food.servingSizeUnit || null,
        calories: extractNutrient(food.foodNutrients, NUTRIENT_NAMES.calories),
        protein: extractNutrient(food.foodNutrients, NUTRIENT_NAMES.protein),
        carbs: extractNutrient(food.foodNutrients, NUTRIENT_NAMES.carbs),
        fat: extractNutrient(food.foodNutrients, NUTRIENT_NAMES.fat)
      };
    } catch (mapError) {
      console.error(`Error processing food item at index ${index}:`, mapError);
      return {
        id: food.fdcId || -1,
        description: food.description || 'Unknown food item',
        brandName: null,
        servingSize: null,
        servingSizeUnit: null,
        calories: null,
        protein: null,
        carbs: null,
        fat: null
      };
    }
  });

  return {
    foods: formattedFoods,
    totalResults: data.totalHits || 0
  };
}


app.get('/foods', async (req: Request<{}, {}, {}, FoodSearchParams>, res: Response) => {
  try {
    const { type, limit = '10' } = req.query;

    if (!type || typeof type !== 'string') {
      return res.status(400).json({
        error: 'Missing required parameter',
        message: "Query parameter 'type' is required and must be a string"
      });
    }

    const sanitizedType = type.trim().slice(0, 100);
    const validTypeRegex = /^[a-zA-Z0-9\s\-'.,()]+$/;
    
    if (!sanitizedType || sanitizedType.length < 2) {
      return res.status(400).json({
        error: 'Invalid parameter',
        message: "Query parameter 'type' must be at least 2 characters long"
      });
    }
    
    if (!validTypeRegex.test(sanitizedType)) {
      return res.status(400).json({
        error: 'Invalid parameter',
        message: "Query parameter 'type' contains invalid characters. Only letters, numbers, spaces, hyphens, apostrophes, periods, commas, and parentheses are allowed"
      });
    }

    const pageSize = parseInt(limit, 10);
    if (isNaN(pageSize) || pageSize < 1 || pageSize > 200) {
      return res.status(400).json({
        error: 'Invalid parameter',
        message: "Query parameter 'limit' must be a number between 1 and 200"
      });
    }

    const apiKey = process.env.USDA_API_KEY;
    if (!apiKey) {
      throw new ConfigurationError('USDA API key is not configured. Please set USDA_API_KEY environment variable.');
    }

    const result = await fetchUSDAFoods(sanitizedType, pageSize);

    if (result.foods.length === 0) {
      throw new NotFoundError(`No foods found matching '${sanitizedType}'. Try a different search term.`);
    }

    return res.status(200).json({
      query: sanitizedType,
      limit: pageSize,
      totalResults: result.totalResults,
      foods: result.foods
    });

  } catch (error) {
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({
        error: error.errorCode,
        message: error.message
      });
    }
    
    console.error('Unexpected error fetching food data:', error);
    
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred. Please try again later.'
    });
  }
});

interface HealthStatus {
  status: string;
  timestamp: string;
  uptime: number;
  environment: string;
  api: {
    usda: {
      configured: boolean;
      status: string;
    };
  };
  error?: string;
}

app.get('/health', async (_req: Request, res: Response) => {
  const healthStatus: HealthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    api: {
      usda: {
        configured: !!process.env.USDA_API_KEY,
        status: 'unknown'
      }
    }
  };

  if (process.env.USDA_API_KEY) {
    try {
      const testUrl = new URL(`${USDA_API_BASE}/foods/search`);
      testUrl.searchParams.append('query', 'apple');
      testUrl.searchParams.append('pageSize', '1');
      testUrl.searchParams.append('api_key', process.env.USDA_API_KEY);
      
      const response = await fetch(testUrl.toString(), { method: 'GET' });
      healthStatus.api.usda.status = response.ok ? 'healthy' : 'unhealthy';
    } catch (error) {
      if (error instanceof AppError) {
        return res.status(error.statusCode).json({
          error: error.errorCode,
          message: error.message
        });
      }
      
      healthStatus.api.usda.status = 'unreachable';
      healthStatus.error = error instanceof Error ? error.message : 'Unknown error';
    }
  }

  const allHealthy = healthStatus.api.usda.status === 'healthy' || !process.env.USDA_API_KEY;
  res.status(allHealthy ? 200 : 503).json(healthStatus);
});

app.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    name: 'MacroMeals API',
    version: '1.0.0',
    description: 'API for fetching food and nutrition information from the USDA FoodData Central',
    documentation: {
      endpoints: [
        {
          path: '/',
          method: 'GET',
          description: 'API information and documentation'
        },
        {
          path: '/health',
          method: 'GET',
          description: 'Health check endpoint - returns API and USDA service status'
        },
        {
          path: '/foods',
          method: 'GET',
          description: 'Search for food items by type',
          parameters: [
            {
              name: 'type',
              required: true,
              type: 'string',
              description: 'Food type to search for (e.g., apple, chicken, rice)'
            },
            {
              name: 'limit',
              required: false,
              type: 'number',
              default: 10,
              max: 200,
              description: 'Number of results to return (1-200)'
            }
          ],
          example: '/foods?type=apple&limit=5',
          response: {
            query: 'string',
            limit: 'number',
            totalResults: 'number',
            foods: [
              {
                id: 'number',
                description: 'string',
                brandName: 'string | null',
                servingSize: 'number | null',
                servingSizeUnit: 'string | null',
                calories: 'number | null',
                protein: 'number | null',
                carbs: 'number | null',
                fat: 'number | null'
              }
            ]
          }
        }
      ]
    },
    disclaimers: {
      usda: 'The data and images from the USDA FoodData Central database are made available under the Creative Commons CC0 1.0 Universal Public Domain Dedication. While we strive for accuracy, the U.S. Department of Agriculture and Agricultural Research Service make no warranty, express or implied, regarding the accuracy, completeness, or utility of any information provided through this API.'
    },
    rateLimit: '100 requests per 15 minutes per IP',
    source: 'Powered by USDA FoodData Central API'
  });
});

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Foods endpoint: http://localhost:${PORT}/foods?type=apple&limit=5`);
  });
}

export default app;
