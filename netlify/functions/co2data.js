// netlify/functions/co2data.js
const axios = require('axios');
const { getStore } = require('@netlify/blobs');

// Cache duration in milliseconds (1 hour)
const CACHE_DURATION = 60 * 60 * 1000;

// Rate limiting implementation using Netlify's KV store
async function checkRateLimit(ip) {
  const store = getStore();
  const key = `ratelimit_${ip}`;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  
  try {
    const data = await store.get(key);
    const requests = data ? JSON.parse(data) : [];
    
    // Remove old requests
    const recentRequests = requests.filter(time => now - time < windowMs);
    
    if (recentRequests.length >= 100) { // 100 requests per 15 minutes
      return false;
    }
    
    recentRequests.push(now);
    await store.set(key, JSON.stringify(recentRequests));
    return true;
  } catch (error) {
    console.error('Rate limit error:', error);
    return true; // Allow request if rate limiting fails
  }
}

async function getCachedData() {
  const store = getStore();
  const cacheKey = 'co2_cache';
  
  try {
    const cache = await store.get(cacheKey);
    if (cache) {
      const { data, timestamp } = JSON.parse(cache);
      if (Date.now() - timestamp < CACHE_DURATION) {
        return data;
      }
    }
    return null;
  } catch (error) {
    console.error('Cache error:', error);
    return null;
  }
}

async function setCachedData(data) {
  const store = getStore();
  const cacheKey = 'co2_cache';
  
  try {
    await store.set(cacheKey, JSON.stringify({
      data,
      timestamp: Date.now()
    }));
  } catch (error) {
    console.error('Cache set error:', error);
  }
}

exports.handler = async (event, context) => {
  // CORS headers allowing all origins
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  // Handle OPTIONS request for CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers
    };
  }

  // Handle health check
  if (event.path === '/.netlify/functions/co2data/health') {
    return {
      statusCode: 200,
      headers,
      body: 'OK'
    };
  }

  // Check rate limit
  const clientIP = event.headers['client-ip'] || event.headers['x-forwarded-for'];
  const isAllowed = await checkRateLimit(clientIP);
  if (!isAllowed) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: 'Too many requests' })
    };
  }

  try {
    // Check cache first
    let data = await getCachedData();
    let isFromCache = false;

    if (!data) {
      // Fetch new data
      const response = await axios.get('https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_daily_mlo.txt', {
        timeout: 5000,
        headers: {
          'User-Agent': 'CO2 Data Proxy Service'
        }
      });
      
      data = response.data;
      await setCachedData(data);
    } else {
      isFromCache = true;
    }

    const responseHeaders = {
      ...headers,
      'Content-Type': 'application/json',
      ...(isFromCache && { 'X-Data-Source': 'cache' })
    };

    return {
      statusCode: 200,
      headers: responseHeaders,
      body: JSON.stringify(data)
    };
  } catch (error) {
    console.error('Error:', error);
    
    // Try to return cached data on error
    const cachedData = await getCachedData();
    if (cachedData) {
      return {
        statusCode: 200,
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'X-Data-Source': 'cache'
        },
        body: JSON.stringify(cachedData)
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Error fetching CO2 data' })
    };
  }
};
