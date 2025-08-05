const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cheerio = require('cheerio');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from frontend
app.use(express.static('public'));

// API endpoint for analyzing keywords
app.get('/api/analyze', async (req, res) => {
  try {
    const { keyword } = req.query;
    
    if (!keyword) {
      return res.status(400).json({ error: 'Keyword is required' });
    }
    
    console.log(`Analyzing keyword: ${keyword}`);
    
    // Scrape Amazon data
    const data = await scrapeAmazonData(keyword);
    
    // Calculate scores
    const scores = calculateScores(data);
    
    res.json({
      keyword,
      ...data,
      scores
    });
    
  } catch (error) {
    console.error('Error analyzing keyword:', error);
    res.status(500).json({ 
      error: 'Failed to analyze keyword',
      message: error.message 
    });
  }
});

// Scrape Amazon data using Puppeteer
async function scrapeAmazonData(keyword) {
  let browser;
  
  try {
    // Launch browser
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu'
      ]
    });
    
    const page = await browser.newPage();
    
    // Set user agent to mimic real browser
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36');
    
    // Set viewport
    await page.setViewport({ width: 1366, height: 768 });
    
    // Navigate to Amazon search
    const url = `https://www.amazon.com/s?k=${encodeURIComponent(keyword)}&i=stripbooks`;
    console.log(`Navigating to: ${url}`);
    
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Wait for results to load
    await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 10000 });
    
    // Get page content
    const content = await page.content();
    const $ = cheerio.load(content);
    
    // Extract total results
    let totalResults = 0;
    const totalText = $('span[data-component-type="s-result-info-bar"]').text() || 
                     $('.a-section.a-spacing-small.a-spacing-top-small').text();
    
    if (totalText) {
      const totalMatch = totalText.match(/of\s+(?:over\s+)?([0-9,]+)\s+results/i);
      if (totalMatch) {
        totalResults = parseInt(totalMatch[1].replace(/,/g, ''));
      }
    }
    
    // Extract book data
    const items = [];
    const bookElements = $('[data-component-type="s-search-result"]');
    
    // Process first 20 items
    for (let i = 0; i < Math.min(bookElements.length, 20); i++) {
      const element = bookElements.eq(i);
      const text = element.text();
      
      try {
        // Extract title
        let title = '';
        const titleElement = element.find('h2 a span').first() || 
                            element.find('h2 .a-text-normal').first() ||
                            element.find('h2 a').first();
        
        if (titleElement.length > 0) {
          title = titleElement.text().trim();
        }
        
        if (!title || title.length < 5) continue;
        
        // Extract ASIN
        let asin = element.attr('data-asin') || 'N/A';
        
        // Extract price
        let price = 0;
        const priceElement = element.find('.a-price-whole');
        if (priceElement.length > 0) {
          const priceText = priceElement.text();
          const priceMatch = priceText.match(/[\d.]+/);
          if (priceMatch) {
            price = parseFloat(priceMatch[0]);
          }
        }
        
        // Extract BSR - multiple patterns
        let bsr = 999999;
        const bsrPatterns = [
          /Best\s*Sellers?\s*Rank.*?[#]([0-9,]+)/i,
          /[#]([0-9,]+)\s+in\s+Books/i,
          /Amazon\s*Best\s*Sellers?\s*Rank.*?[#]([0-9,]+)/i,
          /[#]([0-9,]+)/
        ];
        
        for (const pattern of bsrPatterns) {
          const match = text.match(pattern);
          if (match) {
            bsr = parseInt(match[1].replace(/,/g, ''));
            break;
          }
        }
        
        // Extract rating
        let rating = 0;
        const ratingElement = element.find('.a-icon-alt');
        if (ratingElement.length > 0) {
          const ratingText = ratingElement.text();
          const ratingMatch = ratingText.match(/(\d+\.?\d*)\s*out\s*of/);
          if (ratingMatch) {
            rating = parseFloat(ratingMatch[1]);
          }
        }
        
        // Extract reviews - focus on numbers only
        let reviews = 0;
        
        // Pattern 1: "(1,234 ratings)"
        const parenMatch = text.match(/\(([\d,]+)\s*(?:ratings?|reviews?)\)/i);
        if (parenMatch) {
          reviews = parseInt(parenMatch[1].replace(/,/g, ''));
        }
        
        // Pattern 2: "1,234 global ratings"
        if (reviews === 0) {
          const globalMatch = text.match(/([\d,]+)\s+global\s+(?:ratings?|reviews?)/i);
          if (globalMatch) {
            reviews = parseInt(globalMatch[1].replace(/,/g, ''));
          }
        }
        
        // Pattern 3: "1,234 ratings"
        if (reviews === 0) {
          const reviewMatch = text.match(/([\d,]+)\s+(?:ratings?|reviews?)/i);
          if (reviewMatch) {
            reviews = parseInt(reviewMatch[1].replace(/,/g, ''));
          }
        }
        
        items.push({
          title: title,
          asin: asin,
          price: price,
          bsr: bsr,
          rating: rating,
          reviews: reviews
        });
        
      } catch (e) {
        console.log(`Error processing item ${i}:`, e.message);
        continue;
      }
    }
    
    // Calculate averages
    const validBSRs = items.filter(item => item.bsr > 0 && item.bsr < 999999).map(item => item.bsr);
    const avgBSR = validBSRs.length > 0 ? 
      Math.round(validBSRs.reduce((sum, bsr) => sum + bsr, 0) / validBSRs.length) : 0;
    
    const validReviews = items.filter(item => item.reviews > 0 && item.reviews < 1000000).map(item => item.reviews);
    const avgReviews = validReviews.length > 0 ? 
      Math.round(validReviews.reduce((sum, reviews) => sum + reviews, 0) / validReviews.length) : 0;
    
    const validRatings = items.filter(item => item.rating > 0 && item.rating <= 5).map(item => item.rating);
    const avgRating = validRatings.length > 0 ? 
      Math.round(validRatings.reduce((sum, rating) => sum + rating, 0) / validRatings.length * 10) / 10 : 0;
    
    return { 
      items: items, 
      avgBSR, 
      avgRating, 
      avgReviews,
      totalResults,
      firstPageCount: items.length
    };
    
  } catch (error) {
    console.error('Scraping error:', error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Calculate scores based on your criteria
function calculateScores(data) {
  // Popularity Score
  // Green: <= 1000, Yellow: 1001-3000, Red: > 3000
  function calculatePopularity(totalResults) {
    if (totalResults <= 1000) {
      return { score: 'green', value: 100 };
    } else if (totalResults <= 3000) {
      return { score: 'yellow', value: 50 };
    } else {
      return { score: 'red', value: 0 };
    }
  }
  
  // Profitability Score
  // Green: 6+ books with BSR <= 30,000 AND reviews <= 200
  // Yellow: 3-5 books with BSR <= 30,000 AND reviews <= 200
  // Red: 1-2 books with BSR <= 30,000 AND reviews <= 200
  function calculateProfitability(items) {
    // Count books with BSR <= 30,000 AND reviews <= 200
    const profitableBooks = items.filter(item => 
      item.bsr > 0 && 
      item.bsr <= 30000 && 
      item.reviews <= 200
    ).length;
    
    if (profitableBooks >= 6) {
      return { score: 'green', value: 100, count: profitableBooks };
    } else if (profitableBooks >= 3) {
      return { score: 'yellow', value: 50, count: profitableBooks };
    } else {
      return { score: 'red', value: 0, count: profitableBooks };
    }
  }
  
  // Competition Score
  // Green: 3 books or less with reviews >= 500
  // Yellow: 4-6 books with reviews >= 500
  // Red: 7+ books with reviews >= 500
  function calculateCompetition(items) {
    // Count books with reviews >= 500
    const competitiveBooks = items.filter(item => item.reviews >= 500).length;
    
    if (competitiveBooks <= 3) {
      return { score: 'green', value: 100, count: competitiveBooks };
    } else if (competitiveBooks <= 6) {
      return { score: 'yellow', value: 50, count: competitiveBooks };
    } else {
      return { score: 'red', value: 0, count: competitiveBooks };
    }
  }
  
  // Calculate individual scores
  const popularity = calculatePopularity(data.totalResults);
  const profitability = calculateProfitability(data.items);
  const competition = calculateCompetition(data.items);
  
  // Overall score (average of all three)
  const overallScore = Math.round((popularity.value + profitability.value + competition.value) / 3);
  
  return {
    popularity,
    profitability,
    competition,
    overallScore
  };
}

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

module.exports = app;
