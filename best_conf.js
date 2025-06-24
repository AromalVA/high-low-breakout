const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const path = require('path');

// Configuration ranges for optimization (volumeConfirmation removed)
const PARAM_RANGES = {
  minThreshold: { start: 30, end: 100, step: 10 },
  maxThreshold: { start: 100, end: 300, step: 30 },
  riskRewardRatio: { start: 1.0, end: 3.0, step: 0.5 },
  pullbackPercentage: { start: 0, end: 30, step: 10 },
  minimumStopLossPercent: { start: 0.5, end: 2.0, step: 0.25 }
};

// Validation settings
const VALIDATION_SETTINGS = {
  minimumTrades: 30,  // Minimum number of trades required for a configuration to be considered valid
  description: "Only configurations with at least this many trades will be considered valid"
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
      start: "01/01/2017",  // Start of date range
      end: "01/01/2020"  // End of date range
    }
  },
  volumeConfirmation: {
    enabled: false,  // Always disabled
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
 * Create a configuration object with specific parameter values
 */
function createConfig(params) {
  const config = JSON.parse(JSON.stringify(BASE_CONFIG));
  
  config.minThreshold = params.minThreshold;
  config.maxThreshold = params.maxThreshold;
  config.riskRewardRatio = params.riskRewardRatio;
  config.pullbackPercentage = params.pullbackPercentage;
  config.minimumStopLossPercent = params.minimumStopLossPercent;
  
  return config;
}

/**
 * Count total trades from backtest results - handles multiple possible field names
 */
function getTotalTrades(results) {
  if (!results) return 0;
  
  // Try different possible field combinations
  let totalTrades = 0;
  
  // Method 1: Sum of winning and losing days/trades
  if (typeof results.totalWinningDays === 'number' && typeof results.totalLosingDays === 'number') {
    totalTrades = results.totalWinningDays + results.totalLosingDays;
  }
  // Method 2: Sum of winning and losing trades
  else if (typeof results.totalWinningTrades === 'number' && typeof results.totalLosingTrades === 'number') {
    totalTrades = results.totalWinningTrades + results.totalLosingTrades;
  }
  // Method 3: Direct total trades field
  else if (typeof results.totalTrades === 'number') {
    totalTrades = results.totalTrades;
  }
  // Method 4: Count from allTrades array
  else if (Array.isArray(results.allTrades)) {
    // Count actual trades (filter out undefined/null profits)
    totalTrades = results.allTrades.filter(trade => 
      trade && (
        typeof trade.profit === 'number' || 
        typeof trade.netProfit === 'number' ||
        typeof trade.totalProfit === 'number'
      )
    ).length;
  }
  // Method 5: Try other common field names
  else if (typeof results.tradeCount === 'number') {
    totalTrades = results.tradeCount;
  }
  
  return totalTrades;
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
      // Skip invalid combinations (minThreshold should be less than maxThreshold)
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
 * Save the best configuration to file
 */
function saveBestConfig(bestResult, combinationNumber, totalCombinations, isLiveSave = false) {
  // STRICT VALIDATION: Only save if minimum trades requirement is met
  const totalTrades = getTotalTrades(bestResult.results);
  if (totalTrades < VALIDATION_SETTINGS.minimumTrades) {
    console.log(`❌ SAVE BLOCKED: Configuration has only ${totalTrades} trades (minimum required: ${VALIDATION_SETTINGS.minimumTrades})`);
    return false;
  }
  
  const output = {
    bestConfiguration: bestResult.config,
    results: {
      totalNetProfit: bestResult.profit,
      totalGrossProfit: bestResult.results.totalGrossProfit || 0,
      winRate: bestResult.results.winRate || 0,
      totalTrades: totalTrades,
      averageNetProfitPerTrade: bestResult.results.averageNetProfitPerTrade || 0,
      totalNetReturnPercentage: bestResult.results.totalNetReturnPercentage || 0,
      averageGrossProfitPerTrade: bestResult.results.averageGrossProfitPerTrade || 0,
      totalGrossReturnPercentage: bestResult.results.totalGrossReturnPercentage || 0,
      totalFees: bestResult.results.totalFees || 0,
      breakoutsWithoutEntry: bestResult.results.breakoutsWithoutEntry || 0,
      breakoutsOutsideTimeRange: bestResult.results.breakoutsOutsideTimeRange || 0,
      minimumStopLossRejections: bestResult.results.minimumStopLossRejections || 0
    },
    optimizationInfo: {
      combinationNumber: combinationNumber,
      totalCombinations: totalCombinations,
      progressPercentage: ((combinationNumber / totalCombinations) * 100).toFixed(2),
      timestamp: new Date().toISOString(),
      isLiveSave: isLiveSave,
      saveType: isLiveSave ? 'LIVE_UPDATE' : 'FINAL_RESULT',
      dateRange: {
        start: "01/12/2023",
        end: "15/06/2024"
      },
      threadsUsed: os.cpus().length,
      validationSettings: {
        minimumTradesRequired: VALIDATION_SETTINGS.minimumTrades,
        volumeConfirmationEnabled: false,
        actualTradesFound: totalTrades,
        validationPassed: true
      }
    },
    parameterValues: {
      minThreshold: bestResult.config.minThreshold,
      maxThreshold: bestResult.config.maxThreshold,
      riskRewardRatio: bestResult.config.riskRewardRatio,
      pullbackPercentage: bestResult.config.pullbackPercentage,
      minimumStopLossPercent: bestResult.config.minimumStopLossPercent
    }
  };
  
  try {
    // Write to main file only
    fs.writeFileSync('best_conf.json', JSON.stringify(output, null, 2));
    console.log(`✅ Configuration saved with ${totalTrades} trades (required: ${VALIDATION_SETTINGS.minimumTrades}+)`);
    return true;
  } catch (error) {
    console.error(`❌ Error saving best configuration: ${error.message}`);
    return false;
  }
}

/**
 * Load existing best configuration if it exists
 */
function loadExistingBestConfig() {
  try {
    if (fs.existsSync('best_conf.json')) {
      const content = fs.readFileSync('best_conf.json', 'utf8');
      const existing = JSON.parse(content);
      
      if (existing.results && typeof existing.results.totalNetProfit === 'number') {
        const existingTrades = existing.results.totalTrades || 0;
        
        // Validate that existing config meets current minimum trades requirement
        if (existingTrades >= VALIDATION_SETTINGS.minimumTrades) {
          console.log(`📁 Found valid existing configuration with profit: ₹${existing.results.totalNetProfit.toFixed(2)} (${existingTrades} trades)`);
          return {
            profit: existing.results.totalNetProfit,
            config: existing.bestConfiguration,
            results: existing.results
          };
        } else {
          console.log(`📁 Found existing configuration but it only has ${existingTrades} trades (minimum required: ${VALIDATION_SETTINGS.minimumTrades}). Starting fresh.`);
        }
      }
    }
  } catch (error) {
    console.warn(`⚠️  Could not load existing configuration: ${error.message}`);
  }
  
  return {
    profit: -Infinity,
    config: null,
    results: null
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
    
    const { stockDataPath, combinations, workerId } = workerData;
    
    // Each worker reads the stock data file independently to avoid serialization issues
    let stockData;
    try {
      console.log(`Worker ${workerId}: Loading stock data from ${stockDataPath}`);
      const fileContent = fs.readFileSync(stockDataPath, 'utf8');
      stockData = JSON.parse(fileContent);
      console.log(`Worker ${workerId}: Stock data loaded successfully`);
      
      // Validate stock data
      if (!stockData || !stockData.data) {
        throw new Error('Invalid stock data structure');
      }
      
      const dateCount = Object.keys(stockData.data).length;
      console.log(`Worker ${workerId}: Found ${dateCount} trading days in data`);
      
    } catch (error) {
      parentPort.postMessage({
        type: 'error',
        workerId: workerId,
        error: `Failed to load stock data: ${error.message}`,
        fatal: true
      });
      process.exit(1);
    }
    
    let bestResult = {
      profit: -Infinity,
      config: null,
      results: null,
      combinationIndex: -1
    };
    
    let processedCount = 0;
    let validConfigCount = 0; // Track configs that meet minimum trades
    const totalInChunk = combinations.length;
    
    if (totalInChunk === 0) {
      console.log(`Worker ${workerId}: No combinations to process`);
      parentPort.postMessage({
        type: 'result',
        workerId: workerId,
        bestResult: bestResult,
        processedCount: 0,
        validConfigCount: 0
      });
      process.exit(0);
    }
    
    console.log(`Worker ${workerId}: Processing ${totalInChunk} combinations (minimum ${VALIDATION_SETTINGS.minimumTrades} trades required)`);
    
    // Process each combination in this worker's chunk
    for (let i = 0; i < combinations.length; i++) {
      try {
        const params = combinations[i];
        const config = createConfig(params);
        
        // Add some validation
        if (config.minThreshold >= config.maxThreshold) {
          console.log(`Worker ${workerId}: Skipping invalid config - minThreshold ${config.minThreshold} >= maxThreshold ${config.maxThreshold}`);
          continue;
        }
        
        const results = backtest(stockData, config);
        
        processedCount++;
        
        // Validate results
        if (!results) {
          if (processedCount <= 5) {
            console.log(`Worker ${workerId}: No results returned for combination ${i}`);
          }
          continue;
        }
        
        if (results.error) {
          if (processedCount <= 5) {
            console.log(`Worker ${workerId}: Backtest error for combination ${i}: ${results.error}`);
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
              console.log(`Worker ${workerId}: No valid profit field found for combination ${i}`);
            }
            continue;
          }
        }
        
        // Count total trades using improved function
        const totalTrades = getTotalTrades(results);
        
        // Debug: Log first few results to understand data structure
        if (processedCount <= 5) {
          console.log(`Worker ${workerId}: Result ${processedCount}:`);
          console.log(`  Config: minT=${params.minThreshold}, maxT=${params.maxThreshold}, RR=${params.riskRewardRatio}`);
          console.log(`  Profit: ${profit}`);
          console.log(`  Total trades found: ${totalTrades}`);
          console.log(`  Result fields: ${Object.keys(results).join(', ')}`);
          
          // Show available trade-related fields
          const tradeFields = Object.keys(results).filter(key => 
            key.toLowerCase().includes('trade') || 
            key.toLowerCase().includes('win') || 
            key.toLowerCase().includes('los')
          );
          console.log(`  Trade-related fields: ${tradeFields.join(', ')}`);
          
          if (results.allTrades && Array.isArray(results.allTrades)) {
            console.log(`  allTrades array length: ${results.allTrades.length}`);
            if (results.allTrades.length > 0) {
              const sampleTrade = results.allTrades[0];
              console.log(`  Sample trade fields: ${Object.keys(sampleTrade || {}).join(', ')}`);
            }
          }
        }
        
        // STRICT VALIDATION: Only accept configurations with minimum trades
        if (totalTrades < VALIDATION_SETTINGS.minimumTrades) {
          if (processedCount <= 20) { // Log first 20 rejections for debugging
            console.log(`Worker ${workerId}: Configuration rejected - only ${totalTrades} trades (minimum required: ${VALIDATION_SETTINGS.minimumTrades})`);
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
          
          console.log(`Worker ${workerId}: New best profit: ₹${bestResult.profit.toFixed(2)} with ${totalTrades} trades`);
          
          // Immediately notify main thread of new best result for live saving
          parentPort.postMessage({
            type: 'new_best',
            workerId: workerId,
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
            processed: processedCount,
            total: totalInChunk,
            validConfigs: validConfigCount,
            bestProfit: bestResult.profit
          });
        }
        
      } catch (error) {
        console.error(`Worker ${workerId}: Error processing combination ${i}:`, error.message);
        parentPort.postMessage({
          type: 'error',
          workerId: workerId,
          error: error.message,
          combination: i,
          fatal: false
        });
      }
    }
    
    console.log(`Worker ${workerId}: Completed processing. Valid configs: ${validConfigCount}/${processedCount}. Best profit: ${bestResult.profit === -Infinity ? 'None' : '₹' + bestResult.profit.toFixed(2)}`);
    
    // Send final result back to main thread
    parentPort.postMessage({
      type: 'result',
      workerId: workerId,
      bestResult: bestResult,
      processedCount: processedCount,
      validConfigCount: validConfigCount
    });
    
  } catch (error) {
    console.error(`Worker ${workerId}: Fatal error:`, error.message);
    parentPort.postMessage({
      type: 'error',
      workerId: workerId,
      error: error.message,
      fatal: true
    });
  }
  
  process.exit(0);
}

// ============================================================================
// MAIN THREAD CODE
// ============================================================================
async function main() {
  console.log('=' .repeat(70));
  console.log('MULTI-THREADED TRADING STRATEGY CONFIGURATION OPTIMIZER');
  console.log('=' .repeat(70));
  
  const numCPUs = os.cpus().length;
  console.log(`🔧 Detected ${numCPUs} CPU cores`);
  console.log(`📊 Minimum trades required: ${VALIDATION_SETTINGS.minimumTrades}`);
  console.log(`📊 Volume confirmation: DISABLED (permanently off)`);
  
  // Verify stock data file exists
  const stockDataPath = path.resolve(__dirname, 'SBIN-EQ.json');
  if (!fs.existsSync(stockDataPath)) {
    console.error('✗ Error: SBIN-EQ.json file not found');
    process.exit(1);
  }
  
  // Load existing best configuration if available
  console.log('📁 Loading existing best configuration...');
  let globalBestResult = loadExistingBestConfig();
  
  // Quick validation of stock data and backtest function
  console.log('📁 Validating stock data file and backtest function...');
  try {
    const fileContent = fs.readFileSync(stockDataPath, 'utf8');
    const stockData = JSON.parse(fileContent);
    if (!stockData || !stockData.data) {
      throw new Error('Invalid stock data structure');
    }
    const dateCount = Object.keys(stockData.data).length;
    console.log(`✓ Stock data validated: ${dateCount} trading days found`);
    
    // Test backtest function with a simple configuration
    console.log('🧪 Testing backtest function...');
    const { backtest } = require('./trading-strategy');
    const testConfig = createConfig({
      minThreshold: 60,
      maxThreshold: 180,
      riskRewardRatio: 1.5,
      pullbackPercentage: 10,
      minimumStopLossPercent: 1.0
    });
    
    const testResult = backtest(stockData, testConfig);
    const testTrades = getTotalTrades(testResult);
    
    console.log(`✓ Backtest test completed:`);
    console.log(`  totalNetProfit: ${testResult?.totalNetProfit}`);
    console.log(`  totalProfit: ${testResult?.totalProfit}`);
    console.log(`  Total trades detected: ${testTrades}`);
    console.log(`  Available result fields: ${testResult ? Object.keys(testResult).join(', ') : 'None'}`);
    console.log(`  hasError: ${!!testResult?.error}`);
    
    if (testResult?.error) {
      console.error(`⚠️  Test backtest failed: ${testResult.error}`);
    } else if (testTrades < VALIDATION_SETTINGS.minimumTrades) {
      console.warn(`⚠️  Test configuration only generated ${testTrades} trades (minimum required: ${VALIDATION_SETTINGS.minimumTrades})`);
      console.warn(`💡 Consider adjusting VALIDATION_SETTINGS.minimumTrades or expanding your parameter ranges`);
    }
    
  } catch (error) {
    console.error('✗ Error validating stock data or backtest:', error.message);
    process.exit(1);
  }

  // Generate all parameter combinations
  console.log('\n🔢 Generating parameter combinations...');
  const combinations = generateAllCombinations();
  console.log(`📊 Total valid combinations: ${combinations.toLocaleString()}`);
  
  // Split combinations into chunks for workers (limit to CPU count)
  const chunks = splitIntoChunks(combinations, numCPUs);
  console.log(`⚡ Using ${numCPUs} worker threads (${Math.ceil(combinations.length / numCPUs)} combinations per thread)`);
  
  // Debug: Show chunk distribution
  const nonEmptyChunks = chunks.filter(chunk => chunk.length > 0);
  console.log(`⚡ Creating ${nonEmptyChunks.length} workers for ${chunks.length} chunks:`);
  chunks.forEach((chunk, i) => {
    if (chunk.length > 0) {
      console.log(`   Worker ${i}: ${chunk.length} combinations`);
    }
  });
  
  // Initialize tracking variables
  let totalProcessed = 0;
  let totalValidConfigs = 0;
  const startTime = Date.now();
  const workerStats = new Map();
  let lastProgressTime = startTime;
  
  // Create and start worker threads (limit to CPU count)
  console.log('\n🚀 Starting optimization with worker threads...\n');
  
  const workers = [];
  const workerPromises = [];
  
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].length === 0) continue; // Skip empty chunks
    
    const worker = new Worker(__filename, {
      workerData: {
        stockDataPath: stockDataPath, // Pass file path instead of data
        combinations: chunks[i],
        workerId: i
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
          
          // Report global progress 
          const currentTime = Date.now();
          if ((currentTime - lastProgressTime) > 3000) { // Every 3 seconds
            const elapsed = (currentTime - startTime) / 1000;
            const rate = totalProcessed / elapsed;
            const eta = (combinations.length - totalProcessed) / rate;
            const progress = (totalProcessed / combinations.length * 100).toFixed(2);
            
            const bestProfitDisplay = globalBestResult.profit === -Infinity ? 'None' : `₹${globalBestResult.profit.toFixed(2)}`;
            
            console.log(`📈 Progress: ${totalProcessed.toLocaleString()}/${combinations.length.toLocaleString()} (${progress}%) | Valid: ${totalValidConfigs} | Rate: ${rate.toFixed(0)}/sec | ETA: ${(eta/60).toFixed(1)}min | Best: ${bestProfitDisplay}`);
            lastProgressTime = currentTime;
          }
          
        } else if (message.type === 'new_best') {
          // Handle immediate best result notification for live saving
          if (message.bestResult.profit > globalBestResult.profit) {
            console.log(`🔄 LIVE UPDATE: New global best from Worker ${message.workerId}!`);
            console.log(`   Previous best: ${globalBestResult.profit === -Infinity ? 'None' : '₹' + globalBestResult.profit.toFixed(2)}`);
            console.log(`   New best: ₹${message.bestResult.profit.toFixed(2)}`);
            
            globalBestResult = {
              profit: message.bestResult.profit,
              config: message.bestResult.config,
              results: message.bestResult.results
            };
            
            // LIVE SAVE: Save immediately when new best is found (with strict validation)
            const saveSuccess = saveBestConfig(globalBestResult, totalProcessed + message.processedCount, combinations.length, true);
            
            if (saveSuccess) {
              console.log(`   💾 ✅ LIVE SAVE: Configuration saved to best_conf.json`);
            } else {
              console.log(`   💾 ❌ LIVE SAVE BLOCKED: Configuration doesn't meet minimum trades requirement`);
            }
            
            if (message.bestResult.params) {
              console.log(`   📊 Config: minT=${message.bestResult.params.minThreshold}, maxT=${message.bestResult.params.maxThreshold}, RR=${message.bestResult.params.riskRewardRatio}, PB=${message.bestResult.params.pullbackPercentage}%, MinSL=${message.bestResult.params.minimumStopLossPercent}%`);
            }
          }
          
        } else if (message.type === 'error') {
          if (message.fatal) {
            console.error(`❌ Worker ${message.workerId} fatal error:`, message.error);
            reject(new Error(message.error));
          } else {
            console.error(`⚠️  Worker ${message.workerId} error:`, message.error);
          }
          
        } else if (message.type === 'result') {
          console.log(`📥 Final result from Worker ${message.workerId}: profit = ${message.bestResult.profit}, valid configs = ${message.validConfigCount}/${message.processedCount}`);
          
          // Check if this worker found a better result (shouldn't happen due to live updates, but just in case)
          if (message.bestResult.profit > globalBestResult.profit) {
            console.log(`🔄 Final update: Worker ${message.workerId} found better result than live updates!`);
            
            globalBestResult = {
              profit: message.bestResult.profit,
              config: message.bestResult.config,
              results: message.bestResult.results
            };
          }
          
          totalProcessed += message.processedCount;
          totalValidConfigs += message.validConfigCount || 0;
          
          const workerBestDisplay = message.bestResult.profit === -Infinity ? 'None' : `₹${message.bestResult.profit.toFixed(2)}`;
          console.log(`✅ Worker ${message.workerId} completed: ${message.processedCount} combinations, ${message.validConfigCount} valid, best profit: ${workerBestDisplay}`);
          resolve(message.bestResult);
        }
      });
      
      worker.on('error', (error) => {
        console.error(`❌ Worker ${i} error:`, error);
        reject(error);
      });
      
      worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`⚠️  Worker ${i} stopped with exit code ${code}`);
        }
      });
    });
    
    workerPromises.push(workerPromise);
  }
  
  // Wait for all workers to complete
  try {
    const allResults = await Promise.all(workerPromises);
    
    // Final cleanup
    workers.forEach(worker => worker.terminate());
    
    // Final results
    const totalTime = (Date.now() - startTime) / 1000;
    console.log('\n' + '=' .repeat(70));
    console.log('MULTI-THREADED OPTIMIZATION COMPLETED');
    console.log('=' .repeat(70));
    console.log(`⏱️  Total time: ${(totalTime/60).toFixed(1)} minutes`);
    console.log(`🧵 Threads used: ${numCPUs}`);
    console.log(`📊 Combinations tested: ${combinations.length.toLocaleString()}`);
    console.log(`📊 Valid configurations found: ${totalValidConfigs.toLocaleString()} (${((totalValidConfigs/combinations.length)*100).toFixed(1)}%)`);
    console.log(`📊 Minimum trades filter: ${VALIDATION_SETTINGS.minimumTrades}+ trades required`);
    console.log(`⚡ Average rate: ${(combinations.length/totalTime).toFixed(0)} combinations/second`);
    console.log(`🚀 Speed improvement: ~${numCPUs}x faster than single-threaded`);
    
    if (globalBestResult.profit > -Infinity) {
      const finalTrades = getTotalTrades(globalBestResult.results);
      
      console.log(`\n🏆 BEST CONFIGURATION FOUND:`);
      console.log(`💰 Total Net Profit: ₹${globalBestResult.profit.toFixed(2)}`);
      console.log(`📈 Win Rate: ${globalBestResult.results.winRate?.toFixed(2) || 'N/A'}%`);
      console.log(`📊 Total Trades: ${finalTrades}`);
      console.log(`💵 Average Profit/Trade: ₹${(globalBestResult.results.averageNetProfitPerTrade || 0).toFixed(2)}`);
      console.log(`📊 Return %: ${(globalBestResult.results.totalNetReturnPercentage || 0).toFixed(2)}%`);
      
      console.log(`\n📋 Optimal Parameters:`);
      console.log(`   Min Threshold: ${globalBestResult.config.minThreshold} minutes`);
      console.log(`   Max Threshold: ${globalBestResult.config.maxThreshold} minutes`);
      console.log(`   Risk-Reward Ratio: ${globalBestResult.config.riskRewardRatio}`);
      console.log(`   Pullback Percentage: ${globalBestResult.config.pullbackPercentage}%`);
      console.log(`   Minimum Stop Loss: ${globalBestResult.config.minimumStopLossPercent}%`);
      
      console.log(`\n💾 Final configuration saved to: best_conf.json`);
      console.log(`✅ Validation: ${finalTrades} trades (required: ${VALIDATION_SETTINGS.minimumTrades}+)`);
      
      if (globalBestResult.profit < 0) {
        console.log(`\n⚠️  Note: Best configuration still shows a loss. Consider adjusting strategy parameters.`);
      }
      
    } else {
      console.log(`\n❌ No valid configurations found that meet the minimum trades requirement`);
      console.log(`📊 Total configurations tested: ${combinations.length.toLocaleString()}`);
      console.log(`📊 Valid configurations found: ${totalValidConfigs.toLocaleString()}`);
      console.log(`💡 Suggestions:`);
      console.log(`   • Lower VALIDATION_SETTINGS.minimumTrades (currently ${VALIDATION_SETTINGS.minimumTrades})`);
      console.log(`   • Expand parameter ranges to test more configurations`);
      console.log(`   • Check if your backtest function is returning the expected trade count fields`);
      console.log(`   • Verify your stock data has sufficient trading days`);
    }
    
  } catch (error) {
    console.error('❌ Error in worker threads:', error);
    workers.forEach(worker => worker.terminate());
  }
  
  console.log('=' .repeat(70));
}

// Handle process interruption gracefully
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Process interrupted by user');
  console.log('💾 Best configuration found so far has been saved to best_conf.json');
  process.exit(0);
});

// Run the optimization if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  main,
  PARAM_RANGES,
  BASE_CONFIG,
  VALIDATION_SETTINGS,
  createConfig,
  saveBestConfig,
  generateAllCombinations,
  splitIntoChunks,
  loadExistingBestConfig,
  getTotalTrades
};