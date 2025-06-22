const fs = require('fs');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const os = require('os');
const path = require('path');

// Configuration ranges for optimization
const PARAM_RANGES = {
  minThreshold: { start: 30, end: 100, step: 10 },
  maxThreshold: { start: 100, end: 300, step: 30 },
  riskRewardRatio: { start: 1.0, end: 3.0, step: 0.5 },
  pullbackPercentage: { start: 0, end: 30, step: 10 },
  minimumStopLossPercent: { start: 0.5, end: 2.0, step: 0.25 },
  volumeMultiplier: { start: 1, end: 3, step: 1 },
  lookbackPeriod: { start: 5, end: 20, step: 5 }
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
    enabled: true,
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
  config.volumeConfirmation.volumeMultiplier = params.volumeMultiplier;
  config.volumeConfirmation.lookbackPeriod = params.lookbackPeriod;
  
  return config;
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
  const output = {
    bestConfiguration: bestResult.config,
    results: {
      totalNetProfit: bestResult.profit,
      totalGrossProfit: bestResult.results.totalGrossProfit || 0,
      winRate: bestResult.results.winRate || 0,
      totalTrades: (bestResult.results.totalWinningDays || 0) + (bestResult.results.totalLosingDays || 0),
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
      threadsUsed: os.cpus().length
    },
    parameterValues: {
      minThreshold: bestResult.config.minThreshold,
      maxThreshold: bestResult.config.maxThreshold,
      riskRewardRatio: bestResult.config.riskRewardRatio,
      pullbackPercentage: bestResult.config.pullbackPercentage,
      minimumStopLossPercent: bestResult.config.minimumStopLossPercent,
      volumeMultiplier: bestResult.config.volumeConfirmation.volumeMultiplier,
      lookbackPeriod: bestResult.config.volumeConfirmation.lookbackPeriod
    }
  };
  
  try {
    // Write to main file only
    fs.writeFileSync('best_conf.json', JSON.stringify(output, null, 2));
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
        console.log(`📁 Found existing best configuration with profit: ₹${existing.results.totalNetProfit.toFixed(2)}`);
        return {
          profit: existing.results.totalNetProfit,
          config: existing.bestConfiguration,
          results: existing.results
        };
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
    const totalInChunk = combinations.length;
    
    if (totalInChunk === 0) {
      console.log(`Worker ${workerId}: No combinations to process`);
      parentPort.postMessage({
        type: 'result',
        workerId: workerId,
        bestResult: bestResult,
        processedCount: 0
      });
      process.exit(0);
    }
    
    console.log(`Worker ${workerId}: Processing ${totalInChunk} combinations`);
    
    // Test first combination to ensure everything works
    if (totalInChunk > 0) {
      console.log(`Worker ${workerId}: Testing first combination...`);
      const testParams = combinations[0];
      const testConfig = createConfig(testParams);
      console.log(`Worker ${workerId}: First config - minT: ${testConfig.minThreshold}, maxT: ${testConfig.maxThreshold}, RR: ${testConfig.riskRewardRatio}`);
    }
    
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
        
        // Debug: Always log first 5 results to see what we're getting
        if (processedCount <= 5) {
          console.log(`Worker ${workerId}: Result ${processedCount}:`);
          console.log(`  Config: minT=${params.minThreshold}, maxT=${params.maxThreshold}, RR=${params.riskRewardRatio}`);
          console.log(`  Results type: ${typeof results}, has totalNetProfit: ${results?.hasOwnProperty('totalNetProfit')}`);
          console.log(`  totalNetProfit: ${results?.totalNetProfit}, totalProfit: ${results?.totalProfit}`);
          console.log(`  winningDays: ${results?.totalWinningDays}, losingDays: ${results?.totalLosingDays}`);
          console.log(`  error: ${results?.error}`);
          
          if (results?.allTrades) {
            const actualTrades = results.allTrades.filter(trade => trade.profit !== undefined || trade.netProfit !== undefined);
            console.log(`  Total trades found: ${actualTrades.length}`);
            if (actualTrades.length > 0) {
              const sampleTrade = actualTrades[0];
              console.log(`  Sample trade: ${sampleTrade.date}, profit: ${sampleTrade.netProfit || sampleTrade.profit}`);
            }
          }
        }
        
        // Validate results
        if (!results) {
          console.log(`Worker ${workerId}: No results returned for combination ${i}`);
          continue;
        }
        
        if (results.error) {
          console.log(`Worker ${workerId}: Backtest error for combination ${i}: ${results.error}`);
          continue;
        }
        
        if (typeof results.totalNetProfit !== 'number') {
          console.log(`Worker ${workerId}: Invalid totalNetProfit (${typeof results.totalNetProfit}): ${results.totalNetProfit}`);
          // Try alternative profit fields
          if (typeof results.totalProfit === 'number') {
            console.log(`Worker ${workerId}: Using totalProfit instead: ${results.totalProfit}`);
            results.totalNetProfit = results.totalProfit;
          } else {
            console.log(`Worker ${workerId}: No valid profit field found, skipping`);
            continue;
          }
        }
        
        // Check if this is the best result in this chunk
        if (results.totalNetProfit > bestResult.profit) {
          bestResult = {
            profit: results.totalNetProfit,
            config: config,
            results: results,
            combinationIndex: i,
            params: params
          };
          
          console.log(`Worker ${workerId}: New best profit: ₹${bestResult.profit.toFixed(2)} (was ₹${bestResult.profit === results.totalNetProfit ? 'first' : 'previous'})`);
          
          // Immediately notify main thread of new best result for live saving
          parentPort.postMessage({
            type: 'new_best',
            workerId: workerId,
            bestResult: bestResult,
            processedCount: processedCount
          });
        }
        
        // Report progress every 50 combinations
        if (processedCount % 50 === 0) {
          parentPort.postMessage({
            type: 'progress',
            workerId: workerId,
            processed: processedCount,
            total: totalInChunk,
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
    
    console.log(`Worker ${workerId}: Completed processing. Best profit: ₹${bestResult.profit.toFixed(2)}`);
    
    // Send final result back to main thread
    parentPort.postMessage({
      type: 'result',
      workerId: workerId,
      bestResult: bestResult,
      processedCount: processedCount
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
      minimumStopLossPercent: 1.0,
      volumeMultiplier: 2,
      lookbackPeriod: 10
    });
    
    const testResult = backtest(stockData, testConfig);
    console.log(`✓ Backtest test completed:`);
    console.log(`  totalNetProfit: ${testResult?.totalNetProfit}`);
    console.log(`  totalProfit: ${testResult?.totalProfit}`);
    console.log(`  totalTrades: ${(testResult?.totalWinningDays || 0) + (testResult?.totalLosingDays || 0)}`);
    console.log(`  hasError: ${!!testResult?.error}`);
    
    if (testResult?.error) {
      console.error(`⚠️  Test backtest failed: ${testResult.error}`);
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
  const startTime = Date.now();
  const workerStats = new Map();
  let lastProgressTime = startTime;
  let lastSaveTime = startTime;
  
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
    workerStats.set(i, { processed: 0, total: chunks[i].length, bestProfit: -Infinity });
    
    const workerPromise = new Promise((resolve, reject) => {
      worker.on('message', (message) => {
        if (message.type === 'progress') {
          workerStats.set(message.workerId, {
            processed: message.processed,
            total: workerStats.get(message.workerId).total,
            bestProfit: message.bestProfit
          });
          
          // Update total processed
          totalProcessed = Array.from(workerStats.values()).reduce((sum, stat) => sum + stat.processed, 0);
          
          // Report global progress 
          const currentTime = Date.now();
          if ((currentTime - lastProgressTime) > 3000) { // Every 3 seconds
            const elapsed = (currentTime - startTime) / 1000;
            const rate = totalProcessed / elapsed;
            const eta = (combinations.length - totalProcessed) / rate;
            const progress = (totalProcessed / combinations.length * 100).toFixed(2);
            
            // Show actual best profit (even if negative) instead of 0.00
            const bestProfitDisplay = globalBestResult.profit === -Infinity ? 'None' : `₹${globalBestResult.profit.toFixed(2)}`;
            
            console.log(`📈 Progress: ${totalProcessed.toLocaleString()}/${combinations.length.toLocaleString()} (${progress}%) | Rate: ${rate.toFixed(0)}/sec | ETA: ${(eta/60).toFixed(1)}min | Best: ${bestProfitDisplay}`);
            lastProgressTime = currentTime;
          }
          
        } else if (message.type === 'new_best') {
          // Handle immediate best result notification for live saving
          if (message.bestResult.profit > globalBestResult.profit) {
            console.log(`🔄 LIVE UPDATE: New global best from Worker ${message.workerId}!`);
            console.log(`   Previous best: ₹${globalBestResult.profit === -Infinity ? 'None' : globalBestResult.profit.toFixed(2)}`);
            console.log(`   New best: ₹${message.bestResult.profit.toFixed(2)}`);
            
            globalBestResult = {
              profit: message.bestResult.profit,
              config: message.bestResult.config,
              results: message.bestResult.results
            };
            
            // LIVE SAVE: Save immediately when new best is found
            const saveSuccess = saveBestConfig(globalBestResult, totalProcessed + message.processedCount, combinations.length, true);
            
            if (saveSuccess) {
              console.log(`   💾 ✅ LIVE SAVE: Configuration saved to best_conf.json`);
            } else {
              console.log(`   💾 ❌ LIVE SAVE FAILED!`);
            }
            
            if (message.bestResult.params) {
              console.log(`   📊 Config: minT=${message.bestResult.params.minThreshold}, maxT=${message.bestResult.params.maxThreshold}, RR=${message.bestResult.params.riskRewardRatio}, PB=${message.bestResult.params.pullbackPercentage}%, MinSL=${message.bestResult.params.minimumStopLossPercent}%, Vol=${message.bestResult.params.volumeMultiplier}x, LB=${message.bestResult.params.lookbackPeriod}`);
            }
            
            lastSaveTime = Date.now();
          }
          
        } else if (message.type === 'error') {
          if (message.fatal) {
            console.error(`❌ Worker ${message.workerId} fatal error:`, message.error);
            reject(new Error(message.error));
          } else {
            console.error(`⚠️  Worker ${message.workerId} error:`, message.error);
          }
          
        } else if (message.type === 'result') {
          console.log(`📥 Final result from Worker ${message.workerId}: profit = ${message.bestResult.profit}`);
          
          // Check if this worker found a better result (shouldn't happen due to live updates, but just in case)
          if (message.bestResult.profit > globalBestResult.profit) {
            console.log(`🔄 Final update: Worker ${message.workerId} found better result than live updates!`);
            
            globalBestResult = {
              profit: message.bestResult.profit,
              config: message.bestResult.config,
              results: message.bestResult.results
            };
            
            // Save the best configuration
            const saveSuccess = saveBestConfig(globalBestResult, totalProcessed, combinations.length, false);
            
            if (saveSuccess) {
              console.log(`   💾 Final configuration saved to best_conf.json`);
            }
          }
          
          totalProcessed += message.processedCount;
          const workerBestDisplay = message.bestResult.profit === -Infinity ? 'None' : `₹${message.bestResult.profit.toFixed(2)}`;
          console.log(`✅ Worker ${message.workerId} completed: ${message.processedCount} combinations, best profit: ${workerBestDisplay}`);
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
    
    // Final save (in case no live saves occurred)
    if (globalBestResult.profit > -Infinity) {
      const finalSaveSuccess = saveBestConfig(globalBestResult, combinations.length, combinations.length, false);
      if (finalSaveSuccess) {
        console.log(`💾 Final configuration confirmed in best_conf.json`);
      }
    }
    
    // Final results
    const totalTime = (Date.now() - startTime) / 1000;
    console.log('\n' + '=' .repeat(70));
    console.log('MULTI-THREADED OPTIMIZATION COMPLETED');
    console.log('=' .repeat(70));
    console.log(`⏱️  Total time: ${(totalTime/60).toFixed(1)} minutes`);
    console.log(`🧵 Threads used: ${numCPUs}`);
    console.log(`📊 Combinations tested: ${combinations.length.toLocaleString()}`);
    console.log(`⚡ Average rate: ${(combinations.length/totalTime).toFixed(0)} combinations/second`);
    console.log(`🚀 Speed improvement: ~${numCPUs}x faster than single-threaded`);
    
    if (globalBestResult.profit > -Infinity) {
      console.log(`\n🏆 BEST CONFIGURATION FOUND:`);
      console.log(`💰 Total Net Profit: ₹${globalBestResult.profit.toFixed(2)}`);
      console.log(`📈 Win Rate: ${globalBestResult.results.winRate.toFixed(2)}%`);
      console.log(`📊 Total Trades: ${(globalBestResult.results.totalWinningDays || 0) + (globalBestResult.results.totalLosingDays || 0)}`);
      console.log(`💵 Average Profit/Trade: ₹${(globalBestResult.results.averageNetProfitPerTrade || 0).toFixed(2)}`);
      console.log(`📊 Return %: ${(globalBestResult.results.totalNetReturnPercentage || 0).toFixed(2)}%`);
      
      console.log(`\n📋 Optimal Parameters:`);
      console.log(`   Min Threshold: ${globalBestResult.config.minThreshold} minutes`);
      console.log(`   Max Threshold: ${globalBestResult.config.maxThreshold} minutes`);
      console.log(`   Risk-Reward Ratio: ${globalBestResult.config.riskRewardRatio}`);
      console.log(`   Pullback Percentage: ${globalBestResult.config.pullbackPercentage}%`);
      console.log(`   Minimum Stop Loss: ${globalBestResult.config.minimumStopLossPercent}%`);
      console.log(`   Volume Multiplier: ${globalBestResult.config.volumeConfirmation.volumeMultiplier}x`);
      console.log(`   Lookback Period: ${globalBestResult.config.volumeConfirmation.lookbackPeriod} candles`);
      
      console.log(`\n💾 Final configuration saved to: best_conf.json`);
      
      if (globalBestResult.profit < 0) {
        console.log(`\n⚠️  Note: Best configuration still shows a loss. Consider adjusting strategy parameters.`);
      }
    } else {
      console.log(`\n❌ No valid backtest results found - check data and strategy logic`);
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
  createConfig,
  saveBestConfig,
  generateAllCombinations,
  splitIntoChunks,
  loadExistingBestConfig
};