const { runBacktest } = require('./trading-strategy');
const fs = require('fs');

// Configuration for the backtest
const config = {
  threshold: 70,  // Time threshold for breakout in minutes
  riskRewardRatio: 1,  // Risk to reward ratio
  pullbackPercentage: 10,  // Percentage of stop-loss points to wait for pullback
  entryTimeRange: {
    enabled: true,  // Whether to restrict entry times
    startTime: "9:15", // Entry allowed from this time (24-hour format HH:MM)
    endTime: "14:45"   // Entry allowed until this time (24-hour format HH:MM)
  },
  marketExitTime: {
    enabled: true, // Whether to force exit at specific time
    exitTime: "15:09" // Force exit at this time (24-hour format HH:MM)
  },
  dateFilter: {
    enabled: false,  // Whether to filter by date
    specificDate: "01/12/2023",  // Test a specific day
    dateRange: {
      start: null,  // Start of date range
      end: null  // End of date range
    }
  },
  volumeConfirmation: {
    enabled: true,  // Whether to use volume confirmation
    volumeMultiplier: 1,  // Volume must be X times the average
    lookbackPeriod: 20  // Number of periods to look back for average volume
  },
  capital: {
    initial: 100000,  // Initial capital of 100,000
    utilizationPercent: 100,  // Use 100% of capital for each trade
    leverage: 5,  // 5x leverage
    brokerageFeePercent: 0.06  // 0.06% brokerage fee
  },
  stopLossExitConfig: {
    enabled: true,  // Enable limit order based stop loss exit
    initialTriggerPercent: 70,  // Start placing limit orders when 70% of SL is hit
    incrementPercent: 10,  // Increment by 10% each step (70%, 80%, 90%, etc.)
    maxTriggerPercent: 120,  // Continue until 120% of stop loss is hit
    maxLossPercent: 150,  // Force market exit if loss exceeds 150% of stop loss
    forceMarketOrderAfterMax: true,  // Use market order as circuit breaker
    description: "Place limit sell orders starting at 70% of SL loss, increment by 10% until 120%, circuit breaker at 150%"
  }
};

// Run the backtest
const results = runBacktest('SBIN-EQ.json', config);

// Print summary
console.log('=================== Backtest Results ===================');
console.log(`Initial Capital: ₹${results.initialCapital.toFixed(2)}`);
console.log(`Leverage: ${results.leverage}x`);
console.log(`Brokerage Fee: ${results.brokerageFeePercent}%`);
console.log(`Pullback Percentage: ${config.pullbackPercentage}%`);
console.log(`Entry Time Range: ${config.entryTimeRange.enabled ? `${config.entryTimeRange.startTime} to ${config.entryTimeRange.endTime}` : 'No restriction'}`);
console.log(`Market Exit Time: ${config.marketExitTime.enabled ? config.marketExitTime.exitTime : 'No forced exit'}`);

// Display stop loss configuration
if (config.stopLossExitConfig?.enabled) {
  console.log(`Stop Loss Exit Method: Limit Orders (${config.stopLossExitConfig.initialTriggerPercent}% → ${config.stopLossExitConfig.maxTriggerPercent}%)`);
  console.log(`Stop Loss Increment: ${config.stopLossExitConfig.incrementPercent}%`);
  if (config.stopLossExitConfig.forceMarketOrderAfterMax) {
    console.log(`Circuit Breaker: Market exit at ${config.stopLossExitConfig.maxLossPercent}% loss`);
  }
} else {
  console.log(`Stop Loss Exit Method: Traditional Market Orders`);
}

console.log(`Final Balance: ₹${results.finalBalance.toFixed(2)}`);
console.log(`Total Profit (Without Brokerage): ₹${(results.totalGrossProfit || 0).toFixed(2)}`);
console.log(`Total Profit (With Brokerage): ₹${(results.totalNetProfit || results.totalProfit || 0).toFixed(2)}`);
console.log(`Total Fees Paid: ₹${(results.totalFees || 0).toFixed(2)}`);
console.log(`Total Return % (Without Brokerage): ${(results.totalGrossReturnPercentage || 0).toFixed(2)}%`);
console.log(`Total Return % (With Brokerage): ${(results.totalNetReturnPercentage || results.totalReturnPercentage || 0).toFixed(2)}%`);
console.log(`Average Profit Per Trade (Without Brokerage): ₹${(results.averageGrossProfitPerTrade || 0).toFixed(2)}`);
console.log(`Average Profit Per Trade (With Brokerage): ₹${(results.averageNetProfitPerTrade || results.averageProfitPerTrade || 0).toFixed(2)}`);
console.log(`Average Profit % Per Trade (Without Brokerage): ${(results.averageGrossProfitPercentagePerTrade || 0).toFixed(2)}%`);
console.log(`Average Profit % Per Trade (With Brokerage): ${(results.averageNetProfitPercentagePerTrade || results.averageProfitPercentagePerTrade || 0).toFixed(2)}%`);
console.log(`Win Rate: ${results.winRate.toFixed(2)}%`);
console.log(`Total Trades: ${results.winningDays.length + results.losingDays.length}`);
console.log(`Winning Trades: ${results.totalWinningDays}`);
console.log(`Losing Trades: ${results.totalLosingDays}`);
console.log(`Breakouts Without Entry: ${results.breakoutsWithoutEntry || 0}`);
console.log('======================================================');

// Print enhanced stop loss analysis
if (results.stopLossExitAnalysis?.enabled) {
  console.log('\n============= Stop Loss Exit Analysis ===============');
  console.log(`Limit Order Exits: ${results.stopLossExitAnalysis.totalExitsViaLimitOrders}`);
  console.log(`Traditional SL Exits: ${results.stopLossExitAnalysis.totalTraditionalStopLossExits}`);
  console.log(`Circuit Breaker Exits: ${results.stopLossExitAnalysis.totalCircuitBreakerExits}`);
  console.log(`Avg Profit (Limit Orders): ₹${results.stopLossExitAnalysis.averageProfitLimitOrderExits.toFixed(2)}`);
  console.log(`Avg Profit (Traditional): ₹${results.stopLossExitAnalysis.averageProfitTraditionalExits.toFixed(2)}`);
  console.log(`Avg Profit (Circuit Breaker): ₹${results.stopLossExitAnalysis.averageProfitCircuitBreakerExits.toFixed(2)}`);
  
  const improvementAmount = results.stopLossExitAnalysis.averageProfitLimitOrderExits - results.stopLossExitAnalysis.averageProfitTraditionalExits;
  if (results.stopLossExitAnalysis.totalExitsViaLimitOrders > 0 && results.stopLossExitAnalysis.totalTraditionalStopLossExits > 0) {
    console.log(`Performance Difference: ₹${improvementAmount.toFixed(2)} per trade`);
  }
  console.log('======================================================');
}

// Print detailed breakdown of trades with breakout and entry times
console.log('\n=============== Trade Details Summary ===============');
const actualTrades = results.allTrades.filter(trade => trade.profit !== undefined || trade.netProfit !== undefined);
if (actualTrades.length > 0) {
  console.log('Sample trades with timing and stop loss details:');
  actualTrades.slice(0, 5).forEach((trade, index) => {
    if (trade.breakout) {
      console.log(`\nTrade ${index + 1} (${trade.date}):`);
      console.log(`  Type: ${trade.type.toUpperCase()}`);
      console.log(`  Breakout Time: ${trade.breakout.breakoutTime}`);
      console.log(`  Breakout Price: ₹${trade.breakout.breakoutPrice?.toFixed(2) || 'N/A'}`);
      console.log(`  Actual Entry Time: ${trade.breakout.actualEntryTime || 'N/A'}`);
      console.log(`  Actual Entry Price: ₹${trade.entry.price.toFixed(2)}`);
      console.log(`  Pullback Required: ₹${trade.breakout.pullbackEntryPrice?.toFixed(2) || 'N/A'}`);
      console.log(`  Target: ₹${trade.target.toFixed(2)}`);
      console.log(`  Stop Loss: ₹${trade.stopLoss.toFixed(2)}`);
      console.log(`  Risk Points: ₹${trade.riskPoints.toFixed(2)}`);
      
      // Display stop loss exit details
      if (trade.stopLossExitDetails?.enabled && trade.stopLossExitDetails.triggerLevels.length > 0) {
        console.log(`  Stop Loss Method: Limit Orders`);
        console.log(`  Limit Orders Placed: ${trade.stopLossExitDetails.triggerLevels.length}`);
        trade.stopLossExitDetails.triggerLevels.forEach((level, i) => {
          console.log(`    ${i + 1}. ${level.triggerPercent}% SL @ ₹${level.limitPrice.toFixed(2)} (${level.timeTriggered})`);
        });
        
        // Show which order was actually filled
        if (trade.stopLossExitDetails.orderFillDetails) {
          const fill = trade.stopLossExitDetails.orderFillDetails;
          console.log(`  ✅ Order Filled: ${fill.filledOrderTriggerPercent}% SL @ ₹${fill.filledOrderPrice.toFixed(2)}`);
          console.log(`    Fill Time: ${fill.fillTime} (${fill.timeBetweenPlaceAndFill} mins after placement)`);
          console.log(`    Fill Candle: High ₹${fill.fillCandleHigh.toFixed(2)}, Low ₹${fill.fillCandleLow.toFixed(2)}`);
          if (fill.placedAtCandleIndex !== undefined && fill.filledAtCandleIndex !== undefined) {
            const candleGap = fill.filledAtCandleIndex - fill.placedAtCandleIndex;
            console.log(`    Candle Gap: Placed at index ${fill.placedAtCandleIndex}, filled at index ${fill.filledAtCandleIndex} (${candleGap} candles later)`);
          }
        }
        
        if (trade.stopLossExitDetails.circuitBreakerTriggered) {
          console.log(`  🚨 Circuit Breaker Triggered: ${trade.stopLossExitDetails.maxLossPercent}% max loss exceeded`);
        }
      } else {
        console.log(`  Stop Loss Method: Traditional`);
      }
      
      console.log(`  Exit: ${trade.exit.reason} at ₹${trade.exit.price.toFixed(2)} (${trade.exit.time})`);
      console.log(`  Gross Profit: ₹${(trade.grossProfit || 0).toFixed(2)}`);
      console.log(`  Net Profit: ₹${(trade.netProfit || trade.profit || 0).toFixed(2)}`);
      console.log(`  Max Favorable Excursion: ₹${(trade.maxFavorableExcursion || 0).toFixed(2)}`);
    }
  });
}

// Print breakdown of breakouts without entries
const breakoutsWithoutEntry = results.allTrades.filter(trade => trade.breakoutDetected);
if (breakoutsWithoutEntry.length > 0) {
  console.log(`\n${breakoutsWithoutEntry.length} breakouts detected but no pullback entry occurred:`);
  breakoutsWithoutEntry.slice(0, 3).forEach((trade, index) => {
    console.log(`  ${index + 1}. ${trade.date} - ${trade.breakoutType.toUpperCase()} breakout at ${trade.breakoutTime}, needed pullback to ₹${trade.requiredPullbackPrice?.toFixed(2)}`);
  });
}

// Print exit reason breakdown
console.log('\n=============== Exit Reason Analysis ===============');
if (results.statisticsByExitReason && Object.keys(results.statisticsByExitReason).length > 0) {
  Object.entries(results.statisticsByExitReason).forEach(([reason, stats]) => {
    console.log(`${reason.toUpperCase()}:`);
    console.log(`  Count: ${stats.count}`);
    console.log(`  Total Profit: ₹${stats.totalProfit.toFixed(2)}`);
    console.log(`  Average Profit: ₹${stats.averageProfit.toFixed(2)}`);
    console.log(`  Success Rate: ${((stats.count / actualTrades.length) * 100).toFixed(1)}%`);
  });
}

// Print time-based statistics
console.log('\n=============== Time-Based Statistics ===============');
if (config.entryTimeRange.enabled) {
  const tradesInTimeRange = actualTrades.filter(trade => {
    if (!trade.entry.time) return false;
    const entryTime = trade.entry.time.split(' ')[1]; // Extract time part
    return entryTime >= config.entryTimeRange.startTime && entryTime <= config.entryTimeRange.endTime;
  });
  console.log(`Trades within entry time range (${config.entryTimeRange.startTime}-${config.entryTimeRange.endTime}): ${tradesInTimeRange.length}/${actualTrades.length}`);
}

if (config.marketExitTime.enabled) {
  const forcedExits = actualTrades.filter(trade => trade.exit.reason === 'forced market exit');
  console.log(`Forced market exits at ${config.marketExitTime.exitTime}: ${forcedExits.length}`);
  if (forcedExits.length > 0) {
    const avgForcedExitProfit = forcedExits.reduce((sum, trade) => sum + (trade.netProfit || trade.profit || 0), 0) / forcedExits.length;
    console.log(`Average profit from forced exits: ₹${avgForcedExitProfit.toFixed(2)}`);
  }
}

console.log('======================================================');

// Detailed Stop Loss Configuration Summary
console.log('\n=========== Stop Loss Configuration Summary ===========');
if (config.stopLossExitConfig?.enabled) {
  console.log(`Configuration: ${config.stopLossExitConfig.description}`);
  console.log(`Initial Trigger: ${config.stopLossExitConfig.initialTriggerPercent}% of stop loss hit`);
  console.log(`Increment Steps: ${config.stopLossExitConfig.incrementPercent}%`);
  console.log(`Maximum Trigger: ${config.stopLossExitConfig.maxTriggerPercent}% of stop loss`);
  if (config.stopLossExitConfig.forceMarketOrderAfterMax) {
    console.log(`Circuit Breaker: ${config.stopLossExitConfig.maxLossPercent}% maximum loss (force market exit)`);
  }
  console.log(`Logic: When loss reaches trigger %, place limit order at current adverse price`);
  console.log(`       If price recovers above limit order, exit at limit price`);
  console.log(`       If price continues adverse, place new limit order at next trigger level`);
  if (config.stopLossExitConfig.forceMarketOrderAfterMax) {
    console.log(`       If loss exceeds ${config.stopLossExitConfig.maxLossPercent}%, force immediate market exit`);
  }
} else {
  console.log(`Traditional stop loss: Exit immediately when stop loss price is breached`);
}
console.log('======================================================');

// Write results to a file
fs.writeFileSync('backtest_results.json', JSON.stringify(results, null, 2));
console.log('Detailed results written to backtest_results.json');

// Write configuration used to a separate file for reference
fs.writeFileSync('config_used.json', JSON.stringify(config, null, 2));
console.log('Configuration used written to config_used.json');

// Write stop loss analysis to separate file for detailed review
if (results.stopLossExitAnalysis || config.stopLossExitConfig?.enabled) {
  const stopLossData = {
    configuration: config.stopLossExitConfig,
    analysis: results.stopLossExitAnalysis,
    tradesWithStopLossDetails: actualTrades
      .filter(trade => trade.stopLossExitDetails?.triggerLevels?.length > 0)
      .map(trade => ({
        date: trade.date,
        type: trade.type,
        entryPrice: trade.entry.price,
        exitPrice: trade.exit.price,
        exitReason: trade.exit.reason,
        riskPoints: trade.riskPoints,
        triggerLevels: trade.stopLossExitDetails.triggerLevels,
        orderFillDetails: trade.stopLossExitDetails.orderFillDetails, // NEW: Include fill details with candle indices
        circuitBreakerTriggered: trade.stopLossExitDetails.circuitBreakerTriggered,
        grossProfit: trade.grossProfit,
        netProfit: trade.netProfit
      }))
  };
  
  fs.writeFileSync('stop_loss_analysis.json', JSON.stringify(stopLossData, null, 2));
  console.log('Stop loss analysis written to stop_loss_analysis.json');
}