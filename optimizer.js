const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const os = require('os');
const { runBacktest } = require('./trading-strategy');

// Function to generate all parameter combinations
function generateCombinations() {
  const combinations = [];
  
  // Define ranges for optimization
  for (let threshold = 30; threshold <= 180; threshold += 15) {
    for (let riskRewardRatio = 1.0; riskRewardRatio <= 3.0; riskRewardRatio += 0.2) {
      for (let volumeMultiplier = 1.0; volumeMultiplier <= 4.0; volumeMultiplier += 0.3) {
        for (let lookbackPeriod = 5; lookbackPeriod <= 25; lookbackPeriod += 3) {
          combinations.push({
            threshold: Math.round(threshold),
            riskRewardRatio: Math.round(riskRewardRatio * 10) / 10,
            volumeMultiplier: Math.round(volumeMultiplier * 10) / 10,
            lookbackPeriod: Math.round(lookbackPeriod)
          });
        }
      }
    }
  }
  
  return combinations;
}

// Worker thread code
if (!isMainThread) {
  const { combinations, workerId } = workerData;
  const results = [];
  
  for (let i = 0; i < combinations.length; i++) {
    const combination = combinations[i];
    
    // Report progress back to main thread every 5 combinations
    if (i % 5 === 0 || i === combinations.length - 1) {
      parentPort.postMessage({
        type: 'progress',
        workerId,
        completed: i + 1,
        total: combinations.length
      });
    }
    
    const config = {
      threshold: combination.threshold,
      riskRewardRatio: combination.riskRewardRatio,
      dateFilter: {
        enabled: false,
        specificDate: "01/12/2023",
        dateRange: {
          start: null,
          end: null
        }
      },
      volumeConfirmation: {
        enabled: true,
        volumeMultiplier: combination.volumeMultiplier,
        lookbackPeriod: combination.lookbackPeriod
      },
      capital: {
        initial: 100000,
        utilizationPercent: 100,
        leverage: 5,
        brokerageFeePercent: 0.06
      }
    };

    try {
      const backtest = runBacktest('SBIN-EQ.json', config);
      
      if (backtest && !backtest.error) {
        const totalTrades = (backtest.winningDays?.length || 0) + (backtest.losingDays?.length || 0);
        
        results.push({
          config: combination,
          totalNetProfit: backtest.totalNetProfit || backtest.totalProfit || 0,
          totalNetReturnPercentage: backtest.totalNetReturnPercentage || backtest.totalReturnPercentage || 0,
          winRate: backtest.winRate || 0,
          totalTrades: totalTrades,
          totalFees: backtest.totalFees || 0,
          averageNetProfitPerTrade: backtest.averageNetProfitPerTrade || backtest.averageProfitPerTrade || 0
        });
      }
    } catch (error) {
      // Skip failed configurations silently
    }
  }

  // Send final results back to main thread
  parentPort.postMessage({
    type: 'results',
    results
  });
} 
// Main thread code
else {
  console.time('🕐 Optimization completed in');
  
  // Function to create a progress bar
  function createProgressBar(total, current) {
    const barLength = 40;
    const progress = Math.min(current / total, 1);
    const filled = Math.round(barLength * progress);
    const empty = barLength - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    const percentage = Math.round(progress * 100);
    return `[${bar}] ${percentage}% (${current}/${total})`;
  }
  
  console.log('🚀 Starting Trading Strategy Optimization');
  console.log('==========================================');
  
  // Test data file access
  console.log('🔍 Checking data file...');
  try {
    const testConfig = {
      threshold: 60,
      riskRewardRatio: 1.5,
      dateFilter: { enabled: false },
      volumeConfirmation: { enabled: true, volumeMultiplier: 2, lookbackPeriod: 10 },
      capital: { initial: 100000, utilizationPercent: 100, leverage: 5, brokerageFeePercent: 0.06 }
    };
    const testResult = runBacktest('SBIN-EQ.json', testConfig);
    if (testResult.error) {
      console.log('❌ Error reading data file:', testResult.error);
      return;
    }
    console.log('✅ Data file accessible');
  } catch (error) {
    console.log('❌ Cannot access SBIN-EQ.json:', error.message);
    console.log('💡 Make sure SBIN-EQ.json is in the same directory as optimizer.js');
    return;
  }
  
  // Generate all combinations
  const combinations = generateCombinations();
  console.log(`📊 Generated ${combinations.length} parameter combinations`);
  console.log(`📈 Search Parameters:`);
  console.log(`   Threshold: 30-180 minutes (step: 15)`);
  console.log(`   Risk:Reward Ratio: 1.0-3.0 (step: 0.2)`);
  console.log(`   Volume Multiplier: 1.0-4.0x (step: 0.3)`);
  console.log(`   Lookback Period: 5-25 periods (step: 3)`);

  // Determine number of worker threads
  const numCores = os.cpus().length;
  const numWorkers = Math.min(8, Math.max(1, numCores - 1)); // Use up to 8 workers
  console.log(`⚡ Using ${numWorkers} worker threads for parallel processing`);

  // Divide combinations among workers
  const combinationsPerWorker = Math.ceil(combinations.length / numWorkers);
  const workers = [];
  const workerProgress = new Array(numWorkers).fill(0);
  const workerTotals = new Array(numWorkers).fill(0);
  const results = [];
  let completedWorkers = 0;
  
  // Track global progress
  let totalTested = 0;
  let lastLogTime = Date.now();
  let validResults = 0;
  
  // Setup progress tracking
  const updateProgress = () => {
    const totalProgress = workerProgress.reduce((sum, curr) => sum + curr, 0);
    const totalToProcess = workerTotals.reduce((sum, curr) => sum + curr, 0);
    totalTested = totalProgress;
    
    // Clear the previous line and print progress
    process.stdout.write('\r\x1b[K');
    const progressBar = createProgressBar(totalToProcess, totalProgress);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const rate = elapsed > 0 ? totalProgress / elapsed : 0;
    const eta = rate > 0 ? Math.floor((totalToProcess - totalProgress) / rate) : 0;
    
    process.stdout.write(`🔄 PROGRESS: ${progressBar} | ${validResults} valid | ${elapsed}s | ETA: ${eta > 0 ? eta + 's' : 'N/A'}`);
    
    // Log current best result every 15 seconds when we have results
    const now = Date.now();
    if (now - lastLogTime > 15000 && results.length > 0) {
      lastLogTime = now;
      
      // Sort current results to find the best
      const sortedResults = [...results].sort((a, b) => b.totalNetProfit - a.totalNetProfit);
      const best = sortedResults[0];
      
      console.log('');
      console.log(`\n💰 Current best: ₹${best.totalNetProfit.toFixed(2)} profit | Config: T=${best.config.threshold}min, RR=${best.config.riskRewardRatio}, V=${best.config.volumeMultiplier}x, L=${best.config.lookbackPeriod}`);
    }
  };

  const startTime = Date.now();

  // Track if all workers are done
  const checkCompletion = () => {
    if (completedWorkers === numWorkers) {
      console.log('\n\n✅ Processing complete!');
      
      // Filter and sort by totalNetProfit in descending order
      const validResults = results.filter(r => r.totalNetProfit !== undefined && !isNaN(r.totalNetProfit) && r.totalTrades > 0);
      validResults.sort((a, b) => b.totalNetProfit - a.totalNetProfit);
      
      if (validResults.length === 0) {
        console.log('❌ No valid trading configurations found!');
        return;
      }
      
      // Take top 10
      const top10 = validResults.slice(0, 10);
      
      // Prepare output data
      const outputData = {
        optimizationSummary: {
          bestConfiguration: top10[0].config,
          bestNetProfit: top10[0].totalNetProfit,
          bestReturnPercentage: top10[0].totalNetReturnPercentage,
          totalCombinationsTested: combinations.length,
          validResults: validResults.length,
          optimizationDuration: (Date.now() - startTime) / 1000,
          optimizationDate: new Date().toISOString()
        },
        top10Configurations: top10.map((result, index) => ({
          rank: index + 1,
          configuration: result.config,
          performance: {
            totalNetProfit: result.totalNetProfit,
            totalNetReturnPercentage: result.totalNetReturnPercentage,
            winRate: result.winRate,
            totalTrades: result.totalTrades,
            totalFees: result.totalFees,
            averageNetProfitPerTrade: result.averageNetProfitPerTrade
          }
        }))
      };
      
      // Write results to file
      fs.writeFileSync('confOutput.json', JSON.stringify(outputData, null, 2));
      
      console.log('🏆 TOP 10 CONFIGURATIONS');
      console.log('========================');
      
      top10.forEach((result, index) => {
        console.log(`\n${index + 1}. 🥇 Configuration:`);
        console.log(`   📅 Threshold: ${result.config.threshold} minutes`);
        console.log(`   ⚖️  Risk:Reward Ratio: ${result.config.riskRewardRatio}:1`);
        console.log(`   📊 Volume Multiplier: ${result.config.volumeMultiplier}x`);
        console.log(`   🔍 Lookback Period: ${result.config.lookbackPeriod} periods`);
        console.log(`   💰 Net Profit: ₹${result.totalNetProfit.toFixed(2)}`);
        console.log(`   📈 Return: ${result.totalNetReturnPercentage.toFixed(2)}%`);
        console.log(`   🎯 Win Rate: ${result.winRate.toFixed(2)}%`);
        console.log(`   📊 Total Trades: ${result.totalTrades}`);
      });
      
      console.log('\n💾 Results saved to confOutput.json');
      console.log('\n🎯 OPTIMAL CONFIGURATION FOUND:');
      console.log('================================');
      console.log(`📅 Threshold: ${top10[0].config.threshold} minutes`);
      console.log(`⚖️  Risk:Reward Ratio: ${top10[0].config.riskRewardRatio}:1`);
      console.log(`📊 Volume Multiplier: ${top10[0].config.volumeMultiplier}x`);
      console.log(`🔍 Lookback Period: ${top10[0].config.lookbackPeriod} periods`);
      console.log(`💰 Expected Net Profit: ₹${top10[0].totalNetProfit.toFixed(2)}`);
      console.log(`📈 Expected Return: ${top10[0].totalNetReturnPercentage.toFixed(2)}%`);
      console.log(`🎯 Win Rate: ${top10[0].winRate.toFixed(2)}%`);
      
      console.timeEnd('🕐 Optimization completed in');
    }
  };

  // Create and start workers
  for (let i = 0; i < numWorkers; i++) {
    const startIdx = i * combinationsPerWorker;
    const endIdx = Math.min(startIdx + combinationsPerWorker, combinations.length);
    const workerCombinations = combinations.slice(startIdx, endIdx);
    workerTotals[i] = workerCombinations.length;

    if (workerCombinations.length > 0) {
      const worker = new Worker(__filename, {
        workerData: { 
          combinations: workerCombinations,
          workerId: i
        }
      });
      
      workers.push(worker);

      worker.on('message', (message) => {
        if (message.type === 'progress') {
          workerProgress[message.workerId] = message.completed;
          updateProgress();
        } else if (message.type === 'results') {
          // Collect results
          results.push(...message.results);
          validResults = results.filter(r => r.totalNetProfit !== undefined && !isNaN(r.totalNetProfit) && r.totalTrades > 0).length;
          completedWorkers++;
          checkCompletion();
        }
      });

      worker.on('error', (err) => {
        console.error(`\n❌ Worker ${i} error:`, err);
        completedWorkers++;
        checkCompletion();
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          console.error(`\n⚠️ Worker ${i} stopped with exit code ${code}`);
        }
        completedWorkers++;
        checkCompletion();
      });
    } else {
      completedWorkers++;
    }
  }

  console.log('\n🔄 Starting parallel processing...');
  // Initial progress display
  updateProgress();
}