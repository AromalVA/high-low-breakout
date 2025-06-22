const fs = require('fs');
const { backtest } = require('./trading-strategy');

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
      start: "01/12/2023",
      end: "15/06/2024"
    }
  },
  volumeConfirmation: {
    enabled: true,
    volumeMultiplier: 1, // Will be overridden
    lookbackPeriod: 5    // Will be overridden
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
    values.push(Number(i.toFixed(2))); // Handle floating point precision
  }
  return values;
}

/**
 * Create a configuration object with specific parameter values
 */
function createConfig(params) {
  const config = JSON.parse(JSON.stringify(BASE_CONFIG)); // Deep clone
  
  // Set direct parameters
  config.minThreshold = params.minThreshold;
  config.maxThreshold = params.maxThreshold;
  config.riskRewardRatio = params.riskRewardRatio;
  config.pullbackPercentage = params.pullbackPercentage;
  config.minimumStopLossPercent = params.minimumStopLossPercent;
  
  // Set volume configuration parameters
  config.volumeConfirmation.volumeMultiplier = params.volumeMultiplier;
  config.volumeConfirmation.lookbackPeriod = params.lookbackPeriod;
  
  return config;
}

/**
 * Save the best configuration to file
 */
function saveBestConfig(bestResult, combinationNumber, totalCombinations) {
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
      dateRange: {
        start: "01/12/2023",
        end: "15/06/2024"
      }
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
    fs.writeFileSync('best_conf.json', JSON.stringify(output, null, 2));
  } catch (error) {
    console.error('Error saving best configuration:', error.message);
  }
}

/**
 * Main optimization function
 */
function main() {
  console.log('=' .repeat(60));
  console.log('TRADING STRATEGY CONFIGURATION OPTIMIZER');
  console.log('=' .repeat(60));
  
  // Load stock data once
  console.log('Loading stock data from SBIN-EQ.json...');
  const loadStartTime = Date.now();
  
  let stockData;
  try {
    const fileContent = fs.readFileSync('SBIN-EQ.json', 'utf8');
    stockData = JSON.parse(fileContent);
    const loadTime = Date.now() - loadStartTime;
    console.log(`✓ Stock data loaded successfully in ${loadTime}ms`);
  } catch (error) {
    console.error('✗ Error loading stock data:', error.message);
    process.exit(1);
  }

  // Generate parameter value arrays
  console.log('\nGenerating parameter combinations...');
  const paramValues = {};
  for (const [param, range] of Object.entries(PARAM_RANGES)) {
    paramValues[param] = generateParameterValues(range);
    console.log(`  ${param}: ${paramValues[param].length} values (${paramValues[param][0]} to ${paramValues[param][paramValues[param].length-1]})`);
  }

  // Calculate total combinations
  const totalCombinations = Object.values(paramValues).reduce((total, values) => total * values.length, 1);
  console.log(`\n📊 Total combinations to test: ${totalCombinations.toLocaleString()}`);
  console.log(`⏱️  Estimated time (at 100 combinations/sec): ${(totalCombinations/100/60).toFixed(1)} minutes`);

  // Initialize tracking variables
  let bestResult = {
    profit: -Infinity,
    config: null,
    results: null
  };
  
  let combinationCount = 0;
  const startTime = Date.now();
  let lastProgressTime = startTime;

  // Generate and test all combinations using iterative approach
  console.log('\n🚀 Starting optimization...\n');
  
  const paramNames = Object.keys(paramValues);
  const paramLengths = paramNames.map(name => paramValues[name].length);
  const maxIndices = paramLengths.map(len => len - 1);
  
  // Initialize indices
  const indices = new Array(paramNames.length).fill(0);
  
  while (true) {
    combinationCount++;
    
    // Create configuration for current combination
    const currentParams = {};
    for (let i = 0; i < paramNames.length; i++) {
      currentParams[paramNames[i]] = paramValues[paramNames[i]][indices[i]];
    }
    
    // Skip invalid combinations (minThreshold should be less than maxThreshold)
    if (currentParams.minThreshold >= currentParams.maxThreshold) {
      // Move to next combination
      let carryOver = 1;
      for (let i = paramNames.length - 1; i >= 0 && carryOver; i--) {
        indices[i] += carryOver;
        if (indices[i] > maxIndices[i]) {
          indices[i] = 0;
          carryOver = 1;
        } else {
          carryOver = 0;
        }
      }
      
      if (carryOver) break; // All combinations tested
      continue;
    }
    
    // Progress reporting
    const currentTime = Date.now();
    if (combinationCount % 500 === 0 || (currentTime - lastProgressTime) > 5000) {
      const elapsed = (currentTime - startTime) / 1000;
      const rate = combinationCount / elapsed;
      const eta = (totalCombinations - combinationCount) / rate;
      const progress = (combinationCount / totalCombinations * 100).toFixed(2);
      
      console.log(`📈 Progress: ${combinationCount.toLocaleString()}/${totalCombinations.toLocaleString()} (${progress}%) | Rate: ${rate.toFixed(0)}/sec | ETA: ${(eta/60).toFixed(1)}min | Best: ₹${bestResult.profit === -Infinity ? '0.00' : bestResult.profit.toFixed(2)}`);
      lastProgressTime = currentTime;
    }

    try {
      // Create configuration and run backtest
      const config = createConfig(currentParams);
      const results = backtest(stockData, config);
      
      // Check if this is the best result so far
      if (results.totalNetProfit > bestResult.profit) {
        bestResult = {
          profit: results.totalNetProfit,
          config: config,
          results: results
        };
        
        // Save the best configuration immediately
        saveBestConfig(bestResult, combinationCount, totalCombinations);
        
        console.log(`🎉 NEW BEST FOUND! Profit: ₹${bestResult.profit.toFixed(2)} (Combination #${combinationCount})`);
        console.log(`   Config: minT=${currentParams.minThreshold}, maxT=${currentParams.maxThreshold}, RR=${currentParams.riskRewardRatio}, PB=${currentParams.pullbackPercentage}%, MinSL=${currentParams.minimumStopLossPercent}%, Vol=${currentParams.volumeMultiplier}x, LB=${currentParams.lookbackPeriod}`);
      }
      
    } catch (error) {
      console.error(`❌ Error in combination ${combinationCount}:`, error.message);
    }
    
    // Move to next combination
    let carryOver = 1;
    for (let i = paramNames.length - 1; i >= 0 && carryOver; i--) {
      indices[i] += carryOver;
      if (indices[i] > maxIndices[i]) {
        indices[i] = 0;
        carryOver = 1;
      } else {
        carryOver = 0;
      }
    }
    
    if (carryOver) break; // All combinations tested
  }

  // Final results
  const totalTime = (Date.now() - startTime) / 1000;
  console.log('\n' + '=' .repeat(60));
  console.log('OPTIMIZATION COMPLETED');
  console.log('=' .repeat(60));
  console.log(`⏱️  Total time: ${(totalTime/60).toFixed(1)} minutes`);
  console.log(`📊 Combinations tested: ${combinationCount.toLocaleString()}`);
  console.log(`⚡ Average rate: ${(combinationCount/totalTime).toFixed(0)} combinations/second`);
  
  if (bestResult.profit > -Infinity) {
    console.log(`\n🏆 BEST CONFIGURATION FOUND:`);
    console.log(`💰 Total Net Profit: ₹${bestResult.profit.toFixed(2)}`);
    console.log(`📈 Win Rate: ${bestResult.results.winRate.toFixed(2)}%`);
    console.log(`📊 Total Trades: ${(bestResult.results.totalWinningDays || 0) + (bestResult.results.totalLosingDays || 0)}`);
    console.log(`💵 Average Profit/Trade: ₹${(bestResult.results.averageNetProfitPerTrade || 0).toFixed(2)}`);
    console.log(`📊 Return %: ${(bestResult.results.totalNetReturnPercentage || 0).toFixed(2)}%`);
    
    console.log(`\n📋 Optimal Parameters:`);
    console.log(`   Min Threshold: ${bestResult.config.minThreshold} minutes`);
    console.log(`   Max Threshold: ${bestResult.config.maxThreshold} minutes`);
    console.log(`   Risk-Reward Ratio: ${bestResult.config.riskRewardRatio}`);
    console.log(`   Pullback Percentage: ${bestResult.config.pullbackPercentage}%`);
    console.log(`   Minimum Stop Loss: ${bestResult.config.minimumStopLossPercent}%`);
    console.log(`   Volume Multiplier: ${bestResult.config.volumeConfirmation.volumeMultiplier}x`);
    console.log(`   Lookback Period: ${bestResult.config.volumeConfirmation.lookbackPeriod} candles`);
    
    console.log(`\n💾 Configuration saved to: best_conf.json`);
  } else {
    console.log(`\n❌ No profitable configuration found`);
  }
  
  console.log('=' .repeat(60));
}

// Handle process interruption gracefully
process.on('SIGINT', () => {
  console.log('\n\n⚠️  Process interrupted by user');
  console.log('💾 Best configuration found so far has been saved to best_conf.json');
  process.exit(0);
});

// Run the optimization if this file is executed directly
if (require.main === module) {
  main();
}

module.exports = {
  main,
  PARAM_RANGES,
  BASE_CONFIG,
  createConfig,
  saveBestConfig
};