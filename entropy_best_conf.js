const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const path = require('path');

// Stock symbols to analyze
const STOCK_SYMBOLS = ["SBIN"];

// Configuration ranges for optimization (volumeConfirmation removed)
const PARAM_RANGES = {
  minThreshold: { start: 30, end: 200, step: 5 },
  maxThreshold: { start: 100, end: 300, step: 5 },
  riskRewardRatio: { start: 1, end: 1, step: 0.25 },
  pullbackPercentage: { start: 0, end: 30, step: 5 },
  minimumStopLossPercent: { start: 0.5, end: 0.5, step: 0.25 }
};

// Validation settings
const VALIDATION_SETTINGS = {
  minimumTrades: 0,  // Reduced for broader testing
  description: "Only configurations with at least this many trades will be considered valid"
};

// Date ranges for optimization and validation
const DATE_RANGES = {
  optimization: {
    start: "01/01/2017",
    end: "01/01/2021"
  },
  validation: {
    start: "02/01/2021", 
    end: "01/01/2024"
  }
};

// Base configuration template
const BASE_CONFIG = {
  entryTimeRange: {
    enabled: true,
    startTime: "9:15",
    endTime: "14:45"
  },
  marketExitTime: {
    enabled: true,
    exitTime: "15:09",
    preExitLimitOrderMinutes: 10,
    dynamicPriceAdjustment: true
  },
  dateFilter: {
    enabled: true,
    specificDate: null,
    dateRange: {
      start: "01/01/2017",
      end: "01/01/2018"
    }
  },
  volumeConfirmation: {
    enabled: false,
    volumeMultiplier: 1,
    lookbackPeriod: 5
  },
  capital: {
    initial: 100000,
    utilizationPercent: 100,
    leverage: 5,
    brokerageFeePercent: 0.06
  },
  stopLossExitConfig: {
    enabled: true,
    dynamicStopLossAdjustment: true,
    maxLossPercent: 200,
    forceMarketOrderAfterMax: true,
    description: "Wait for actual SL breach, place limit order at breach candle close, dynamically adjust if not filled"
  },
  targetExitConfig: {
    enabled: true,
    dynamicTargetAdjustment: true,
    description: "Place limit order when target hit, skip one candle, then check for fill"
  },
  entryOrderConfig: {
    enabled: true,
    dynamicEntryAdjustment: true,
    description: "Place limit order when pullback hit, skip one candle, then check for fill"
  },
  priceRounding: {
    enabled: true,
    tickSize: 0.05
  }
};

/**
 * Generate array of values for a parameter range
 */
function generateParameterValues(range) {
  const values = [];
  for (let i = range.start; i <= range.end; i += range.step) {
    values.push(Number(i.toFixed(2)));
  }
  return values;
}

/**
 * Create a configuration object with specific parameter values and date range
 */
function createConfig(params, dateRange) {
  const config = JSON.parse(JSON.stringify(BASE_CONFIG));
  
  config.minThreshold = params.minThreshold;
  config.maxThreshold = params.maxThreshold;
  config.riskRewardRatio = params.riskRewardRatio;
  config.pullbackPercentage = params.pullbackPercentage;
  config.minimumStopLossPercent = params.minimumStopLossPercent;
  
  // Set the date range
  config.dateFilter.dateRange.start = dateRange.start;
  config.dateFilter.dateRange.end = dateRange.end;
  
  return config;
}

/**
 * Count total trades from backtest results
 */
function getTotalTrades(results) {
  if (!results) return 0;
  
  let totalTrades = 0;
  
  if (typeof results.totalWinningDays === 'number' && typeof results.totalLosingDays === 'number') {
    totalTrades = results.totalWinningDays + results.totalLosingDays;
  }
  else if (typeof results.totalWinningTrades === 'number' && typeof results.totalLosingTrades === 'number') {
    totalTrades = results.totalWinningTrades + results.totalLosingTrades;
  }
  else if (typeof results.totalTrades === 'number') {
    totalTrades = results.totalTrades;
  }
  else if (Array.isArray(results.allTrades)) {
    totalTrades = results.allTrades.filter(trade => 
      trade && (
        typeof trade.profit === 'number' || 
        typeof trade.netProfit === 'number' ||
        typeof trade.totalProfit === 'number'
      )
    ).length;
  }
  else if (typeof results.tradeCount === 'number') {
    totalTrades = results.tradeCount;
  }
  
  return totalTrades;
}

/**
 * Get average net profit percentage per trade
 */
function getAverageNetProfitPercentagePerTrade(results) {
  if (!results) return 0;
  
  // Try different possible field names
  if (typeof results.averageNetProfitPercentagePerTrade === 'number') {
    return results.averageNetProfitPercentagePerTrade;
  }
  
  // Calculate from available data
  const totalTrades = getTotalTrades(results);
  if (totalTrades === 0) return 0;
  
  let totalReturnPercentage = 0;
  if (typeof results.totalNetReturnPercentage === 'number') {
    totalReturnPercentage = results.totalNetReturnPercentage;
  } else if (typeof results.totalGrossReturnPercentage === 'number') {
    totalReturnPercentage = results.totalGrossReturnPercentage;
  }
  
  return totalReturnPercentage / totalTrades;
}

/**
 * Generate all valid parameter combinations
 */
function generateAllCombinations() {
  const paramValues = {};
  for (const [param, range] of Object.entries(PARAM_RANGES)) {
    paramValues[param] = generateParameterValues(range);
  }

  const combinations = [];
  const paramNames = Object.keys(paramValues);
  
  function generateRecursive(index, current) {
    if (index === paramNames.length) {
      if (current.minThreshold < current.maxThreshold) {
        combinations.push({ ...current });
      }
      return;
    }
    
    const param = paramNames[index];
    for (const value of paramValues[param]) {
      current[param] = value;
      generateRecursive(index + 1, current);
    }
  }
  
  generateRecursive(0, {});
  return combinations;
}

/**
 * Split combinations into chunks for worker threads
 */
function splitIntoChunks(combinations, numChunks) {
  const chunks = [];
  const chunkSize = Math.ceil(combinations.length / numChunks);
  
  for (let i = 0; i < numChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, combinations.length);
    if (start < combinations.length) {
      chunks.push(combinations.slice(start, end));
    }
  }
  
  return chunks;
}

/**
 * Calculate entropy for a stock
 */
function calculateEntropy(optimizationResults, validationResults) {
  const optAvgProfitPercentage = getAverageNetProfitPercentagePerTrade(optimizationResults);
  const valAvgProfitPercentage = getAverageNetProfitPercentagePerTrade(validationResults);
  
  const entropy = valAvgProfitPercentage - optAvgProfitPercentage;
  
  return {
    entropy: entropy,
    optimizationAvgProfitPercentage: optAvgProfitPercentage,
    validationAvgProfitPercentage: valAvgProfitPercentage
  };
}

// ============================================================================
// WORKER THREAD CODE
// ============================================================================
if (!isMainThread) {
  try {
    // Import the trading strategy module with proper path resolution
    const tradingStrategy = require(path.resolve(__dirname, 'trading-strategy.js'));
    const { backtest } = tradingStrategy;
    
    const { stockDataPath, combinations, workerId, stockSymbol, dateRange } = workerData;
    
    // Each worker reads the stock data file independently to avoid serialization issues
    let stockData;
    try {
      console.log(`Worker ${workerId} (${stockSymbol}): Loading stock data from ${stockDataPath}`);
      const fileContent = fs.readFileSync(stockDataPath, 'utf8');
      stockData = JSON.parse(fileContent);
      console.log(`Worker ${workerId} (${stockSymbol}): Stock data loaded successfully`);
      
      // Validate stock data
      if (!stockData || !stockData.data) {
        throw new Error('Invalid stock data structure');
      }
      
      const dateCount = Object.keys(stockData.data).length;
      console.log(`Worker ${workerId} (${stockSymbol}): Found ${dateCount} trading days in data`);
      
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        workerId: workerId,
        stockSymbol: stockSymbol,
        error: `Failed to load stock data: ${error.message}`,
        fatal: true
      });
      process.exit(1);
    }
    
    let bestResult = {
      profit: -Infinity,
      config: null,
      results: null,
      combinationIndex: -1,
      params: null
    };
    
    let processedCount = 0;
    let validConfigCount = 0;
    const totalInChunk = combinations.length;
    
    if (totalInChunk === 0) {
      console.log(`Worker ${workerId} (${stockSymbol}): No combinations to process`);
      parentPort.postMessage({
        type: 'result',
        workerId: workerId,
        stockSymbol: stockSymbol,
        bestResult: bestResult,
        processedCount: 0,
        validConfigCount: 0
      });
      process.exit(0);
    }
    
    console.log(`Worker ${workerId} (${stockSymbol}): Processing ${totalInChunk} combinations (minimum ${VALIDATION_SETTINGS.minimumTrades} trades required)`);
    
    // Process each combination in this worker's chunk
    for (let i = 0; i < combinations.length; i++) {
      try {
        const params = combinations[i];
        const config = createConfig(params, dateRange);
        
        // Add some validation
        if (config.minThreshold >= config.maxThreshold) {
          console.log(`Worker ${workerId} (${stockSymbol}): Skipping invalid config - minThreshold ${config.minThreshold} >= maxThreshold ${config.maxThreshold}`);
          continue;
        }
        
        const results = backtest(stockData, config);
        
        processedCount++;
        
        // Validate results
        if (!results) {
          if (processedCount <= 5) {
            console.log(`Worker ${workerId} (${stockSymbol}): No results returned for combination ${i}`);
          }
          continue;
        }
        
        if (results.error) {
          if (processedCount <= 5) {
            console.log(`Worker ${workerId} (${stockSymbol}): Backtest error for combination ${i}: ${results.error}`);
          }
          continue;
        }
        
        // Get profit value
        let profit = results.totalNetProfit;
        if (typeof profit !== 'number') {
          if (typeof results.totalProfit === 'number') {
            profit = results.totalProfit;
          } else {
            if (processedCount <= 5) {
              console.log(`Worker ${workerId} (${stockSymbol}): No valid profit field found for combination ${i}`);
            }
            continue;
          }
        }
        
        // Count total trades using improved function
        const totalTrades = getTotalTrades(results);
        
        // Debug: Log first few results to understand data structure
        if (processedCount <= 3) {
          console.log(`Worker ${workerId} (${stockSymbol}): Result ${processedCount}:`);
          console.log(`  Config: minT=${params.minThreshold}, maxT=${params.maxThreshold}, RR=${params.riskRewardRatio}`);
          console.log(`  Profit: ${profit}`);
          console.log(`  Total trades found: ${totalTrades}`);
        }
        
        // STRICT VALIDATION: Only accept configurations with minimum trades
        if (totalTrades < VALIDATION_SETTINGS.minimumTrades) {
          if (processedCount <= 10) { // Log first 10 rejections for debugging
            console.log(`Worker ${workerId} (${stockSymbol}): Configuration rejected - only ${totalTrades} trades (minimum required: ${VALIDATION_SETTINGS.minimumTrades})`);
          }
          continue;
        }
        
        validConfigCount++;
        
        // Check if this is the best result in this chunk
        if (profit > bestResult.profit) {
          bestResult = {
            profit: profit,
            config: config,
            results: results,
            combinationIndex: i,
            params: params
          };
          
          console.log(`Worker ${workerId} (${stockSymbol}): New best profit: ₹${bestResult.profit.toFixed(2)} with ${totalTrades} trades`);
          
          // Immediately notify main thread of new best result
          parentPort.postMessage({
            type: 'new_best',
            workerId: workerId,
            stockSymbol: stockSymbol,
            bestResult: bestResult,
            processedCount: processedCount,
            validConfigCount: validConfigCount
          });
        }
        
        // Report progress every 50 combinations
        if (processedCount % 50 === 0) {
          parentPort.postMessage({
            type: 'progress',
            workerId: workerId,
            stockSymbol: stockSymbol,
            processed: processedCount,
            total: totalInChunk,
            validConfigs: validConfigCount,
            bestProfit: bestResult.profit
          });
        }
        
      } catch (error) {
        console.error(`Worker ${workerId} (${stockSymbol}): Error processing combination ${i}:`, error.message);
        parentPort.postMessage({
          type: 'error',
          workerId: workerId,
          stockSymbol: stockSymbol,
          error: error.message,
          combination: i,
          fatal: false
        });
      }
    }
    
    console.log(`Worker ${workerId} (${stockSymbol}): Completed processing. Valid configs: ${validConfigCount}/${processedCount}. Best profit: ${bestResult.profit === -Infinity ? 'None' : '₹' + bestResult.profit.toFixed(2)}`);
    
    // Send final result back to main thread
    parentPort.postMessage({
      type: 'result',
      workerId: workerId,
      stockSymbol: stockSymbol,
      bestResult: bestResult,
      processedCount: processedCount,
      validConfigCount: validConfigCount
    });
    
  } catch (error) {
    console.error(`Worker ${workerId} (${stockSymbol}): Fatal error:`, error.message);
    parentPort.postMessage({
      type: 'error',
      workerId: workerId,
      stockSymbol: stockSymbol,
      error: error.message,
      fatal: true
    });
  }
  
  process.exit(0);
}

// ============================================================================
// MAIN THREAD CODE - MULTI-THREADED OPTIMIZATION FOR SINGLE STOCK
// ============================================================================

/**
 * Find best configuration for a stock using multi-threading
 */
async function findBestConfigForStockMultiThreaded(stockSymbol, stockDataPath) {
  console.log(`\n🔧 Starting multi-threaded optimization for ${stockSymbol}...`);
  
  const numCPUs = os.cpus().length;
  console.log(`🔧 Using ${numCPUs} CPU cores for ${stockSymbol}`);
  
  // Generate all parameter combinations
  const combinations = generateAllCombinations();
  console.log(`🔢 ${stockSymbol}: Testing ${combinations.length.toLocaleString()} parameter combinations`);
  
  // Split combinations into chunks for workers
  const chunks = splitIntoChunks(combinations, numCPUs);
  console.log(`⚡ ${stockSymbol}: Creating ${numCPUs} workers`);
  
  // Initialize tracking variables
  let globalBestResult = {
    profit: -Infinity,
    config: null,
    results: null,
    params: null
  };
  
  let totalProcessed = 0;
  let totalValidConfigs = 0;
  const startTime = Date.now();
  const workerStats = new Map();
  let lastProgressTime = startTime;
  
  const workers = [];
  const workerPromises = [];
  
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].length === 0) continue;
    
    const worker = new Worker(__filename, {
      workerData: {
        stockDataPath: stockDataPath,
        combinations: chunks[i],
        workerId: i,
        stockSymbol: stockSymbol,
        dateRange: DATE_RANGES.optimization
      }
    });
    
    workers.push(worker);
    workerStats.set(i, { processed: 0, total: chunks[i].length, validConfigs: 0, bestProfit: -Infinity });
    
    const workerPromise = new Promise((resolve, reject) => {
      worker.on('message', (message) => {
        if (message.type === 'progress') {
          workerStats.set(message.workerId, {
            processed: message.processed,
            total: workerStats.get(message.workerId).total,
            validConfigs: message.validConfigs || 0,
            bestProfit: message.bestProfit
          });
          
          // Update totals
          totalProcessed = Array.from(workerStats.values()).reduce((sum, stat) => sum + stat.processed, 0);
          totalValidConfigs = Array.from(workerStats.values()).reduce((sum, stat) => sum + stat.validConfigs, 0);
          
          // Report progress every 3 seconds
          const currentTime = Date.now();
          if ((currentTime - lastProgressTime) > 3000) {
            const elapsed = (currentTime - startTime) / 1000;
            const rate = totalProcessed / elapsed;
            const eta = (combinations.length - totalProcessed) / rate;
            const progress = (totalProcessed / combinations.length * 100).toFixed(2);
            
            const bestProfitDisplay = globalBestResult.profit === -Infinity ? 'None' : `₹${globalBestResult.profit.toFixed(2)}`;
            
            console.log(`📈 ${stockSymbol}: ${totalProcessed.toLocaleString()}/${combinations.length.toLocaleString()} (${progress}%) | Valid: ${totalValidConfigs} | Rate: ${rate.toFixed(0)}/sec | ETA: ${(eta/60).toFixed(1)}min | Best: ${bestProfitDisplay}`);
            lastProgressTime = currentTime;
          }
          
        } else if (message.type === 'new_best') {
          if (message.bestResult.profit > globalBestResult.profit) {
            console.log(`🔄 ${stockSymbol}: New best from Worker ${message.workerId}! ₹${globalBestResult.profit === -Infinity ? 'None' : globalBestResult.profit.toFixed(2)} → ₹${message.bestResult.profit.toFixed(2)}`);
            
            globalBestResult = {
              profit: message.bestResult.profit,
              config: message.bestResult.config,
              results: message.bestResult.results,
              params: message.bestResult.params
            };
          }
          
        } else if (message.type === 'error') {
          if (message.fatal) {
            console.error(`❌ ${stockSymbol} Worker ${message.workerId} fatal error:`, message.error);
            reject(new Error(message.error));
          } else {
            console.error(`⚠️  ${stockSymbol} Worker ${message.workerId} error:`, message.error);
          }
          
        } else if (message.type === 'result') {
          if (message.bestResult.profit > globalBestResult.profit) {
            globalBestResult = {
              profit: message.bestResult.profit,
              config: message.bestResult.config,
              results: message.bestResult.results,
              params: message.bestResult.params
            };
          }
          
          totalProcessed += message.processedCount;
          totalValidConfigs += message.validConfigCount || 0;
          
          const workerBestDisplay = message.bestResult.profit === -Infinity ? 'None' : `₹${message.bestResult.profit.toFixed(2)}`;
          console.log(`✅ ${stockSymbol} Worker ${message.workerId}: ${message.processedCount} combinations, ${message.validConfigCount} valid, best: ${workerBestDisplay}`);
          resolve(message.bestResult);
        }
      });
      
      worker.on('error', (error) => {
        console.error(`❌ ${stockSymbol} Worker ${i} error:`, error);
        reject(error);
      });
      
      worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`⚠️  ${stockSymbol} Worker ${i} stopped with exit code ${code}`);
        }
      });
    });
    
    workerPromises.push(workerPromise);
  }
  
  try {
    await Promise.all(workerPromises);
    workers.forEach(worker => worker.terminate());
    
    const totalTime = (Date.now() - startTime) / 1000;
    console.log(`⏱️  ${stockSymbol} optimization completed in ${(totalTime/60).toFixed(1)} minutes`);
    console.log(`📊 ${stockSymbol}: ${totalValidConfigs}/${combinations.length.toLocaleString()} valid configurations found`);
    
    return globalBestResult;
    
  } catch (error) {
    console.error(`❌ ${stockSymbol}: Error in worker threads:`, error);
    workers.forEach(worker => worker.terminate());
    throw error;
  }
}

/**
 * Validate configuration on validation period (single-threaded)
 */
function validateConfiguration(stockSymbol, stockDataPath, bestConfig) {
  console.log(`🧪 Validating ${stockSymbol} configuration on validation period...`);
  
  try {
    // Load stock data
    const fileContent = fs.readFileSync(stockDataPath, 'utf8');
    const stockData = JSON.parse(fileContent);
    
    const { backtest } = require('./trading-strategy');
    
    // Create validation config with same parameters but different date range
    const validationConfig = JSON.parse(JSON.stringify(bestConfig));
    validationConfig.dateFilter.dateRange.start = DATE_RANGES.validation.start;
    validationConfig.dateFilter.dateRange.end = DATE_RANGES.validation.end;
    
    const validationResults = backtest(stockData, validationConfig);
    
    if (!validationResults || validationResults.error) {
      console.log(`❌ ${stockSymbol}: Validation failed - ${validationResults?.error || 'No results'}`);
      return null;
    }
    
    const validationTrades = getTotalTrades(validationResults);
    const validationProfit = validationResults.totalNetProfit || validationResults.totalProfit || 0;
    
    console.log(`✅ ${stockSymbol} validation complete: ${validationTrades} trades, Profit: ₹${validationProfit.toFixed(2)}`);
    
    return validationResults;
    
  } catch (error) {
    console.log(`❌ ${stockSymbol}: Validation error - ${error.message}`);
    return null;
  }
}

/**
 * Process a single stock with multi-threading
 */
async function processStock(stockSymbol) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`📈 PROCESSING STOCK: ${stockSymbol}`);
  console.log(`${'='.repeat(60)}`);
  
  // Check if stock data file exists
  const stockDataPath = path.resolve(__dirname, `${stockSymbol}-EQ.json`);
  if (!fs.existsSync(stockDataPath)) {
    console.log(`❌ ${stockSymbol}: File ${stockSymbol}-EQ.json not found. Skipping.`);
    return null;
  }
  
  // Test load stock data
  try {
    const fileContent = fs.readFileSync(stockDataPath, 'utf8');
    const stockData = JSON.parse(fileContent);
    
    if (!stockData || !stockData.data) {
      throw new Error('Invalid stock data structure');
    }
    
    const dateCount = Object.keys(stockData.data).length;
    console.log(`📊 ${stockSymbol}: Loaded ${dateCount} trading days`);
    
  } catch (error) {
    console.log(`❌ ${stockSymbol}: Error loading data - ${error.message}. Skipping.`);
    return null;
  }
  
  try {
    // Multi-threaded optimization phase
    const bestResult = await findBestConfigForStockMultiThreaded(stockSymbol, stockDataPath);
    
    if (bestResult.profit === -Infinity) {
      console.log(`❌ ${stockSymbol}: No valid configuration found in optimization period. Skipping.`);
      return null;
    }
    
    console.log(`🏆 ${stockSymbol} optimization result: ₹${bestResult.profit.toFixed(2)}`);
    
    // Single-threaded validation phase
    const validationResults = validateConfiguration(stockSymbol, stockDataPath, bestResult.config);
    
    if (!validationResults) {
      console.log(`❌ ${stockSymbol}: Validation failed. Skipping.`);
      return null;
    }
    
    // Calculate entropy
    const entropyData = calculateEntropy(bestResult.results, validationResults);
    
    // Prepare result
    const result = {
      symbol: stockSymbol,
      entropy: entropyData.entropy,
      optimizationPeriod: DATE_RANGES.optimization,
      validationPeriod: DATE_RANGES.validation,
      bestConfiguration: {
        minThreshold: bestResult.params.minThreshold,
        maxThreshold: bestResult.params.maxThreshold,
        riskRewardRatio: bestResult.params.riskRewardRatio,
        pullbackPercentage: bestResult.params.pullbackPercentage,
        minimumStopLossPercent: bestResult.params.minimumStopLossPercent
      },
      optimizationResults: {
        totalNetProfit: bestResult.profit,
        totalTrades: getTotalTrades(bestResult.results),
        averageNetProfitPercentagePerTrade: entropyData.optimizationAvgProfitPercentage,
        winRate: bestResult.results.winRate || 0,
        totalNetReturnPercentage: bestResult.results.totalNetReturnPercentage || 0
      },
      validationResults: {
        totalNetProfit: validationResults.totalNetProfit || validationResults.totalProfit || 0,
        totalTrades: getTotalTrades(validationResults),
        averageNetProfitPercentagePerTrade: entropyData.validationAvgProfitPercentage,
        winRate: validationResults.winRate || 0,
        totalNetReturnPercentage: validationResults.totalNetReturnPercentage || 0
      }
    };
    
    console.log(`\n📊 ${stockSymbol} SUMMARY:`);
    console.log(`   Entropy: ${entropyData.entropy.toFixed(4)}`);
    console.log(`   Optimization Avg Profit %/Trade: ${entropyData.optimizationAvgProfitPercentage.toFixed(4)}`);
    console.log(`   Validation Avg Profit %/Trade: ${entropyData.validationAvgProfitPercentage.toFixed(4)}`);
    console.log(`   Optimization Total Profit: ₹${bestResult.profit.toFixed(2)}`);
    console.log(`   Validation Total Profit: ₹${result.validationResults.totalNetProfit.toFixed(2)}`);
    
    return result;
    
  } catch (error) {
    console.error(`❌ Error processing ${stockSymbol}: ${error.message}`);
    return null;
  }
}

/**
 * Main function to process all stocks
 */
async function main() {
  console.log('=' .repeat(70));
  console.log('MULTI-STOCK ENTROPY ANALYSIS OPTIMIZER (MULTI-THREADED)');
  console.log('=' .repeat(70));
  console.log(`🧵 Detected ${os.cpus().length} CPU cores`);
  console.log(`📊 Optimization Period: ${DATE_RANGES.optimization.start} to ${DATE_RANGES.optimization.end}`);
  console.log(`📊 Validation Period: ${DATE_RANGES.validation.start} to ${DATE_RANGES.validation.end}`);
  console.log(`📊 Minimum trades required: ${VALIDATION_SETTINGS.minimumTrades}`);
  console.log(`📊 Stocks to analyze: ${STOCK_SYMBOLS.join(', ')}`);
  
  const startTime = Date.now();
  const results = [];
  
  // Process each stock sequentially (multi-threading within each stock)
  for (let i = 0; i < STOCK_SYMBOLS.length; i++) {
    const stockSymbol = STOCK_SYMBOLS[i];
    console.log(`\n🔄 Processing ${i + 1}/${STOCK_SYMBOLS.length}: ${stockSymbol}`);
    
    try {
      const result = await processStock(stockSymbol);
      if (result) {
        results.push(result);
        console.log(`✅ ${stockSymbol} completed successfully. Entropy: ${result.entropy.toFixed(4)}`);
      }
    } catch (error) {
      console.error(`❌ Error processing ${stockSymbol}: ${error.message}`);
    }
  }
  
  if (results.length === 0) {
    console.log('\n❌ No valid results found for any stocks.');
    return;
  }
  
  // Sort by entropy (descending - highest entropy first)
  results.sort((a, b) => b.entropy - a.entropy);
  
  // Prepare output
  const output = {
    metadata: {
      analysisDate: new Date().toISOString(),
      optimizationPeriod: DATE_RANGES.optimization,
      validationPeriod: DATE_RANGES.validation,
      minimumTradesRequired: VALIDATION_SETTINGS.minimumTrades,
      stocksAnalyzed: results.length,
      totalStocksAttempted: STOCK_SYMBOLS.length,
      processingTimeMinutes: ((Date.now() - startTime) / 60000).toFixed(2),
      cpuCoresUsed: os.cpus().length,
      multiThreadingEnabled: true
    },
    entropyDefinition: {
      formula: "entropy = validation_avg_profit_percentage_per_trade - optimization_avg_profit_percentage_per_trade",
      interpretation: {
        positive: "Stock performed better in validation period than optimization period",
        negative: "Stock performed worse in validation period than optimization period (possible overfitting)",
        zero: "Stock performed similarly in both periods"
      }
    },
    results: results
  };
  
  // Save to file
  try {
    fs.writeFileSync('entropy.json', JSON.stringify(output, null, 2));
    console.log('\n✅ Results saved to entropy.json');
  } catch (error) {
    console.error('❌ Error saving results:', error.message);
  }
  
  // Display summary
  const totalTime = (Date.now() - startTime) / 1000;
  console.log('\n' + '=' .repeat(70));
  console.log('ENTROPY ANALYSIS COMPLETED');
  console.log('=' .repeat(70));
  console.log(`⏱️  Total time: ${(totalTime/60).toFixed(1)} minutes`);
  console.log(`🧵 CPU cores used: ${os.cpus().length} (multi-threaded optimization per stock)`);
  console.log(`📊 Stocks successfully analyzed: ${results.length}/${STOCK_SYMBOLS.length}`);
  
  console.log('\n🏆 TOP 5 STOCKS BY ENTROPY:');
  results.slice(0, 5).forEach((result, index) => {
    const entropyStatus = result.entropy > 0 ? '📈' : result.entropy < 0 ? '📉' : '➡️';
    console.log(`${index + 1}. ${result.symbol}: ${entropyStatus} ${result.entropy.toFixed(4)} (Opt: ${result.optimizationResults.averageNetProfitPercentagePerTrade.toFixed(4)}, Val: ${result.validationResults.averageNetProfitPercentagePerTrade.toFixed(4)})`);
  });
  
  console.log('\n🔻 BOTTOM 5 STOCKS BY ENTROPY:');
  results.slice(-5).reverse().forEach((result, index) => {
    const entropyStatus = result.entropy > 0 ? '📈' : result.entropy < 0 ? '📉' : '➡️';
    console.log(`${results.length - index}. ${result.symbol}: ${entropyStatus} ${result.entropy.toFixed(4)} (Opt: ${result.optimizationResults.averageNetProfitPercentagePerTrade.toFixed(4)}, Val: ${result.validationResults.averageNetProfitPercentagePerTrade.toFixed(4)})`);
  });
  
  console.log('\n💾 Detailed results saved to: entropy.json');
  console.log('=' .repeat(70));
}

// Handle process interruption gracefully
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Process interrupted by user');
  console.log('💾 Partial results may have been saved to entropy.json');
  process.exit(0);
});

// Run the analysis if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  main,
  STOCK_SYMBOLS,
  PARAM_RANGES,
  BASE_CONFIG,
  VALIDATION_SETTINGS,
  DATE_RANGES,
  createConfig,
  generateAllCombinations,
  processStock,
  calculateEntropy,
  getTotalTrades,
  getAverageNetProfitPercentagePerTrade,
  findBestConfigForStockMultiThreaded
};