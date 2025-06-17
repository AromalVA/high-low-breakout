const { runBacktest } = require('./trading-strategy');
const fs = require('fs');

// Configuration for the backtest with DYNAMIC STOP LOSS AND PRE-MARKET EXIT ORDERS
const config = {
  minThreshold: 70,  // Minimum time threshold for breakout in minutes
  maxThreshold: 300, // Maximum time threshold for breakout in minutes
  riskRewardRatio: 1,  // Risk to reward ratio
  pullbackPercentage: 10,  // Percentage of stop-loss points to wait for pullback
  entryTimeRange: {
    enabled: true,  // Whether to restrict entry times
    startTime: "9:15", // Entry allowed from this time (24-hour format HH:MM)
    endTime: "14:45"   // Entry allowed until this time (24-hour format HH:MM)
  },
  marketExitTime: {
    enabled: true, // Whether to force exit at specific time
    exitTime: "15:09", // Force exit at this time (24-hour format HH:MM)
    preExitLimitOrderMinutes: 10, // Place limit order X minutes before market exit time
    dynamicPriceAdjustment: true // Enable dynamic price adjustment for pre-market exit orders
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
    enabled: true,  // Enable dynamic stop loss exit system
    dynamicStopLossAdjustment: true,  // Enable dynamic price adjustment for stop loss orders
    maxLossPercent: 200,  // Force market exit if loss exceeds 200% of stop loss (circuit breaker)
    forceMarketOrderAfterMax: true,  // Use market order as circuit breaker
    description: "Wait for actual SL breach, place limit order at breach candle close, dynamically adjust if not filled"
  }
};

// Run the backtest
const results = runBacktest('SBIN-EQ.json', config);

// Print summary
console.log('=================== Backtest Results ===================');
console.log(`Initial Capital: ₹${results.initialCapital.toFixed(2)}`);
console.log(`Leverage: ${results.leverage}x`);
console.log(`Brokerage Fee: ${results.brokerageFeePercent}%`);
console.log(`Time Threshold Range: ${config.minThreshold} - ${config.maxThreshold} minutes`);
console.log(`Pullback Percentage: ${config.pullbackPercentage}%`);
console.log(`Entry Time Range: ${config.entryTimeRange.enabled ? `${config.entryTimeRange.startTime} to ${config.entryTimeRange.endTime}` : 'No restriction'}`);
console.log(`Market Exit Time: ${config.marketExitTime.enabled ? config.marketExitTime.exitTime : 'No forced exit'}`);

// Display pre-market exit configuration
if (config.marketExitTime?.enabled) {
  console.log(`Pre-Market Exit Order: ${config.marketExitTime.preExitLimitOrderMinutes} minutes before market exit`);
  console.log(`Pre-Market Dynamic Pricing: ${config.marketExitTime.dynamicPriceAdjustment ? 'ENABLED' : 'DISABLED'}`);
}

// Display NEW dynamic stop loss configuration
if (config.stopLossExitConfig?.enabled) {
  console.log(`Stop Loss Method: Dynamic Limit Orders`);
  console.log(`Stop Loss Dynamic Pricing: ${config.stopLossExitConfig.dynamicStopLossAdjustment ? 'ENABLED' : 'DISABLED'}`);
  if (config.stopLossExitConfig.forceMarketOrderAfterMax) {
    console.log(`Circuit Breaker: Market exit at ${config.stopLossExitConfig.maxLossPercent}% loss`);
  }
} else {
  console.log(`Stop Loss Method: Traditional Market Orders`);
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
console.log(`Breakouts Outside Time Range: ${results.breakoutsOutsideTimeRange || 0}`);
console.log('======================================================');

// Enhanced dynamic stop loss analysis
if (results.stopLossExitAnalysis?.enabled) {
  console.log('\n============= Dynamic Stop Loss Analysis =============');
  console.log(`Dynamic Stop Loss Adjustment: ${results.stopLossExitAnalysis.dynamicStopLossAdjustment ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Dynamic Stop Loss Exits: ${results.stopLossExitAnalysis.totalDynamicStopLossExits}`);
  console.log(`Traditional SL Exits: ${results.stopLossExitAnalysis.totalTraditionalStopLossExits}`);
  console.log(`Circuit Breaker Exits: ${results.stopLossExitAnalysis.totalCircuitBreakerExits}`);
  console.log(`Total Trades with SL Breach: ${results.stopLossExitAnalysis.totalTradesWithStopLossBreach}`);
  console.log(`Trades with Dynamic Adjustment: ${results.stopLossExitAnalysis.totalTradesWithDynamicAdjustment}`);
  console.log(`Avg Profit (Dynamic SL Exits): ₹${results.stopLossExitAnalysis.averageProfitDynamicStopLossExits.toFixed(2)}`);
  console.log(`Avg Profit (Traditional SL): ₹${results.stopLossExitAnalysis.averageProfitTraditionalExits.toFixed(2)}`);
  console.log(`Avg Profit (Circuit Breaker): ₹${results.stopLossExitAnalysis.averageProfitCircuitBreakerExits.toFixed(2)}`);
  
  if (results.stopLossExitAnalysis.dynamicStopLossAdjustment) {
    console.log(`Average SL Price Updates per Trade: ${results.stopLossExitAnalysis.averageStopLossPriceUpdates.toFixed(1)}`);
  }
  
  const slImprovementAmount = results.stopLossExitAnalysis.averageProfitDynamicStopLossExits - results.stopLossExitAnalysis.averageProfitTraditionalExits;
  if (results.stopLossExitAnalysis.totalDynamicStopLossExits > 0 && results.stopLossExitAnalysis.totalTraditionalStopLossExits > 0) {
    console.log(`Performance Difference: ₹${slImprovementAmount.toFixed(2)} per trade`);
  }
  console.log('======================================================');
}

// Enhanced pre-market exit analysis with dynamic pricing
if (results.preMarketExitAnalysis?.enabled) {
  console.log('\n=========== Pre-Market Exit Analysis ================');
  console.log(`Dynamic Price Adjustment: ${results.preMarketExitAnalysis.dynamicPriceAdjustment ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Pre-Market Limit Order Exits: ${results.preMarketExitAnalysis.totalPreMarketExits}`);
  console.log(`Forced Market Exits: ${results.preMarketExitAnalysis.totalForcedMarketExits}`);
  console.log(`Total Trades with Pre-Market Orders: ${results.preMarketExitAnalysis.totalTradesWithPreMarketOrders}`);
  console.log(`Pre-Market Order Fill Rate: ${results.preMarketExitAnalysis.preMarketOrderFillRate.toFixed(1)}%`);
  console.log(`Avg Profit (Pre-Market Exits): ₹${results.preMarketExitAnalysis.averageProfitPreMarketExits.toFixed(2)}`);
  console.log(`Avg Profit (Forced Exits): ₹${results.preMarketExitAnalysis.averageProfitForcedExits.toFixed(2)}`);
  
  const preMarketImprovement = results.preMarketExitAnalysis.averageProfitPreMarketExits - results.preMarketExitAnalysis.averageProfitForcedExits;
  if (results.preMarketExitAnalysis.totalPreMarketExits > 0 && results.preMarketExitAnalysis.totalForcedMarketExits > 0) {
    console.log(`Performance Difference: ₹${preMarketImprovement.toFixed(2)} per trade`);
  }
  console.log(`Pre-Exit Order Timing: ${results.preMarketExitAnalysis.preExitLimitOrderMinutes} minutes before market close`);
  
  // Dynamic pricing statistics
  if (results.preMarketExitAnalysis.dynamicPriceAdjustment) {
    console.log('\n--- Pre-Market Dynamic Pricing Statistics ---');
    console.log(`Trades with Dynamic Pricing: ${results.preMarketExitAnalysis.totalTradesWithDynamicPricing}`);
    console.log(`Average Price Updates per Trade: ${results.preMarketExitAnalysis.averagePriceUpdatesPerTrade.toFixed(1)}`);
    console.log(`Average Price Improvement vs Original: ₹${results.preMarketExitAnalysis.averagePriceImprovement.toFixed(2)}`);
    console.log(`Average Price Improvement vs Forced Exit: ₹${results.preMarketExitAnalysis.averagePriceImprovementVsForcedExit.toFixed(2)}`);
    console.log(`Dynamic Pricing Fill Rate: ${results.preMarketExitAnalysis.dynamicPricingFillRate.toFixed(1)}%`);
  }
  console.log('======================================================');
}

// Print detailed breakdown of trades with enhanced exit details
console.log('\n=============== Trade Details Summary ===============');
const actualTrades = results.allTrades.filter(trade => trade.profit !== undefined || trade.netProfit !== undefined);
if (actualTrades.length > 0) {
  console.log('Sample trades with timing and exit details:');
  actualTrades.slice(0, 5).forEach((trade, index) => {
    if (trade.breakout) {
      console.log(`\nTrade ${index + 1} (${trade.date}):`);
      console.log(`  Type: ${trade.type.toUpperCase()}`);
      console.log(`  Breakout Time: ${trade.breakout.breakoutTime}`);
      console.log(`  Breakout Price: ₹${trade.breakout.breakoutPrice?.toFixed(2) || 'N/A'}`);
      console.log(`  Time Since Previous Extreme: ${trade.breakout.timeSincePreviousExtreme} mins`);
      console.log(`  Actual Entry Time: ${trade.breakout.actualEntryTime || 'N/A'}`);
      console.log(`  Actual Entry Price: ₹${trade.entry.price.toFixed(2)}`);
      console.log(`  Pullback Required: ₹${trade.breakout.pullbackEntryPrice?.toFixed(2) || 'N/A'}`);
      console.log(`  Target: ₹${trade.target.toFixed(2)}`);
      console.log(`  Stop Loss: ₹${trade.stopLoss.toFixed(2)}`);
      console.log(`  Risk Points: ₹${trade.riskPoints.toFixed(2)}`);
      
      // Enhanced dynamic stop loss exit details
      if (trade.stopLossExitDetails?.enabled) {
        if (trade.stopLossExitDetails.stopLossBreached) {
          console.log(`  Stop Loss Method: Dynamic Limit Orders`);
          console.log(`  SL Breach: ${trade.stopLossExitDetails.breachCandleTime} @ ₹${trade.stopLossExitDetails.breachCandleClose.toFixed(2)}`);
          
          if (trade.stopLossExitDetails.limitOrderHistory.length > 0) {
            console.log(`  Limit Order History:`);
            trade.stopLossExitDetails.limitOrderHistory.forEach((order, i) => {
              console.log(`    ${i + 1}. ${order.action.toUpperCase()}: ₹${order.price.toFixed(2)} at ${order.time} (${order.reason})`);
            });
          }
          
          if (trade.stopLossExitDetails.dynamicStopLossAdjustment && trade.stopLossExitDetails.totalPriceUpdates > 0) {
            console.log(`  🔄 Dynamic SL Updates: ${trade.stopLossExitDetails.totalPriceUpdates} price adjustments`);
          }
          
          if (trade.stopLossExitDetails.orderFillDetails) {
            const fill = trade.stopLossExitDetails.orderFillDetails;
            console.log(`  ✅ Order Filled: ₹${fill.filledOrderPrice.toFixed(2)} at ${fill.fillTime}`);
            console.log(`    Fill Time: ${fill.timeBetweenPlaceAndFill} mins after placement`);
            console.log(`    Fill Candle: High ₹${fill.fillCandleHigh.toFixed(2)}, Low ₹${fill.fillCandleLow.toFixed(2)}`);
          }
          
          if (trade.stopLossExitDetails.circuitBreakerTriggered) {
            console.log(`  🚨 Circuit Breaker: ${trade.stopLossExitDetails.maxLossPercent}% max loss exceeded`);
          }
        } else {
          console.log(`  Stop Loss Method: No breach occurred`);
        }
      } else {
        console.log(`  Stop Loss Method: Traditional`);
      }
      
      // Enhanced pre-market exit details with dynamic pricing
      if (trade.preMarketExitDetails?.enabled) {
        console.log(`  Pre-Market Exit Configuration:`);
        if (trade.preMarketExitDetails.orderPlaced) {
          console.log(`    📋 Order Placed: ${trade.preMarketExitDetails.orderPlacementTime} @ ₹${trade.preMarketExitDetails.orderPlacementPrice.toFixed(2)}`);
          
          // Show dynamic price updates
          if (trade.preMarketExitDetails.dynamicPriceAdjustment && trade.preMarketExitDetails.priceUpdateHistory.length > 0) {
            console.log(`    🔄 Dynamic Price Updates (${trade.preMarketExitDetails.totalPriceUpdates}):`);
            trade.preMarketExitDetails.priceUpdateHistory.forEach((update, i) => {
              console.log(`      ${i + 1}. ${update.time}: ₹${update.oldPrice.toFixed(2)} → ₹${update.newPrice.toFixed(2)}`);
            });
          }
          
          if (trade.preMarketExitDetails.orderFilled) {
            console.log(`    ✅ Order Filled: ${trade.preMarketExitDetails.orderFillTime} @ ₹${trade.preMarketExitDetails.orderFillPrice.toFixed(2)}`);
            const candleGap = trade.preMarketExitDetails.orderFillCandleIndex - trade.preMarketExitDetails.orderPlacementCandleIndex;
            console.log(`    Candle Gap: ${candleGap} candles between placement and fill`);
            
            if (trade.preMarketExitDetails.priceImprovement !== 0) {
              console.log(`    💰 Price Improvement vs Original: ₹${trade.preMarketExitDetails.priceImprovement.toFixed(2)}`);
            }
          } else {
            console.log(`    ❌ Order Not Filled (fell back to forced market exit)`);
            if (trade.preMarketExitDetails.priceImprovementVsForcedExit !== 0) {
              console.log(`    💸 Missed Opportunity vs Forced Exit: ₹${trade.preMarketExitDetails.priceImprovementVsForcedExit.toFixed(2)}`);
            }
          }
        } else {
          console.log(`    ❌ No Pre-Market Order Placed`);
        }
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

// Print breakdown of breakouts outside time range
const breakoutsOutsideTimeRange = results.allTrades.filter(trade => trade.breakoutOutsideTimeRange);
if (breakoutsOutsideTimeRange.length > 0) {
  console.log(`\n${breakoutsOutsideTimeRange.length} breakouts detected but outside time threshold range:`);
  breakoutsOutsideTimeRange.slice(0, 3).forEach((trade, index) => {
    console.log(`  ${index + 1}. ${trade.date} - ${trade.breakoutType.toUpperCase()} breakout at ${trade.breakoutTime}, time gap: ${trade.timeGap} mins (outside ${config.minThreshold}-${config.maxThreshold} range)`);
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
  const preMarketExits = actualTrades.filter(trade => trade.exit.reason === 'pre-market exit limit order filled');
  
  console.log(`Pre-market exit limit orders filled: ${preMarketExits.length}`);
  console.log(`Forced market exits at ${config.marketExitTime.exitTime}: ${forcedExits.length}`);
  
  if (preMarketExits.length > 0) {
    const avgPreMarketExitProfit = preMarketExits.reduce((sum, trade) => sum + (trade.netProfit || trade.profit || 0), 0) / preMarketExits.length;
    console.log(`Average profit from pre-market exits: ₹${avgPreMarketExitProfit.toFixed(2)}`);
  }
  
  if (forcedExits.length > 0) {
    const avgForcedExitProfit = forcedExits.reduce((sum, trade) => sum + (trade.netProfit || trade.profit || 0), 0) / forcedExits.length;
    console.log(`Average profit from forced exits: ₹${avgForcedExitProfit.toFixed(2)}`);
  }
}

console.log('======================================================');

// Detailed Threshold Configuration Summary
console.log('\n=========== Threshold Configuration Summary ===========');
console.log(`Time Threshold Range: ${config.minThreshold} - ${config.maxThreshold} minutes`);
console.log(`Logic: Breakouts are only considered valid if the time since previous`);
console.log(`       extreme (high/low) is between ${config.minThreshold} and ${config.maxThreshold} minutes`);
console.log(`       This filters out breakouts that occur too quickly (noise) or`);
console.log(`       too slowly (stale patterns)`);
console.log('======================================================');

// Enhanced Dynamic Stop Loss Configuration Summary
console.log('\n========== Dynamic Stop Loss Configuration ===========');
if (config.stopLossExitConfig?.enabled) {
  console.log(`Configuration: ${config.stopLossExitConfig.description}`);
  console.log(`Dynamic Price Adjustment: ${config.stopLossExitConfig.dynamicStopLossAdjustment ? 'ENABLED' : 'DISABLED'}`);
  
  if (config.stopLossExitConfig.dynamicStopLossAdjustment) {
    console.log(`Dynamic Logic: 1. Wait for actual stop loss breach`);
    console.log(`              2. If breach candle closes below SL, place limit order at close price`);
    console.log(`              3. If price recovers above limit order, fill the order`);
    console.log(`              4. If not filled, update limit order to new candle close (if worse)`);
    console.log(`              5. Continue until filled or circuit breaker triggered`);
  } else {
    console.log(`Static Logic: Place limit order at breach candle close and wait for recovery`);
  }
  
  if (config.stopLossExitConfig.forceMarketOrderAfterMax) {
    console.log(`Circuit Breaker: ${config.stopLossExitConfig.maxLossPercent}% maximum loss triggers immediate market exit`);
  }
} else {
  console.log(`Traditional stop loss: Exit immediately when stop loss price is breached`);
}
console.log('======================================================');

// Enhanced Pre-Market Exit Configuration Summary
console.log('\n========= Pre-Market Exit Configuration Summary =======');
if (config.marketExitTime?.enabled) {
  console.log(`Market Exit Time: ${config.marketExitTime.exitTime}`);
  console.log(`Pre-Exit Order Timing: ${config.marketExitTime.preExitLimitOrderMinutes || 10} minutes before market exit`);
  console.log(`Dynamic Price Adjustment: ${config.marketExitTime.dynamicPriceAdjustment ? 'ENABLED' : 'DISABLED'}`);
  
  if (config.marketExitTime.dynamicPriceAdjustment) {
    console.log(`Dynamic Logic: Update limit order price to current candle close if previous order not filled`);
    console.log(`Benefits: - Adapts to real-time market movements`);
    console.log(`         - Higher fill rates vs static pricing`);
    console.log(`         - More realistic exit execution`);
    console.log(`         - Captures favorable price movements in final minutes`);
  } else {
    console.log(`Static Logic: Place limit order at closing price of trigger candle and wait`);
    console.log(`             Order price remains unchanged until filled or market close`);
  }
  
  console.log(`Fallback: If limit order not filled, force market exit at configured time`);
} else {
  console.log(`Pre-market exit orders: Disabled`);
  console.log(`Market will close positions at end of day using closing prices`);
}
console.log('======================================================');

// Write results to a file
fs.writeFileSync('backtest_results.json', JSON.stringify(results, null, 2));
console.log('Detailed results written to backtest_results.json');

// Write configuration used to a separate file for reference
fs.writeFileSync('config_used.json', JSON.stringify(config, null, 2));
console.log('Configuration used written to config_used.json');

// Enhanced stop loss analysis with dynamic pricing details
if (results.stopLossExitAnalysis || config.stopLossExitConfig?.enabled) {
  const stopLossData = {
    configuration: config.stopLossExitConfig,
    analysis: results.stopLossExitAnalysis,
    tradesWithDynamicStopLossDetails: actualTrades
      .filter(trade => trade.stopLossExitDetails?.stopLossBreached)
      .map(trade => ({
        date: trade.date,
        type: trade.type,
        entryPrice: trade.entry.price,
        exitPrice: trade.exit.price,
        exitReason: trade.exit.reason,
        stopLossBreached: trade.stopLossExitDetails.stopLossBreached,
        breachCandleTime: trade.stopLossExitDetails.breachCandleTime,
        breachCandleClose: trade.stopLossExitDetails.breachCandleClose,
        limitOrderHistory: trade.stopLossExitDetails.limitOrderHistory,
        totalPriceUpdates: trade.stopLossExitDetails.totalPriceUpdates,
        originalLimitPrice: trade.stopLossExitDetails.originalLimitPrice,
        finalLimitPrice: trade.stopLossExitDetails.finalLimitPrice,
        orderFillDetails: trade.stopLossExitDetails.orderFillDetails,
        circuitBreakerTriggered: trade.stopLossExitDetails.circuitBreakerTriggered,
        grossProfit: trade.grossProfit,
        netProfit: trade.netProfit
      }))
  };
  
  fs.writeFileSync('dynamic_stop_loss_analysis.json', JSON.stringify(stopLossData, null, 2));
  console.log('Dynamic stop loss analysis written to dynamic_stop_loss_analysis.json');
}

// Enhanced pre-market exit analysis with dynamic pricing details
if (results.preMarketExitAnalysis || config.marketExitTime?.enabled) {
  const preMarketExitData = {
    configuration: config.marketExitTime,
    analysis: results.preMarketExitAnalysis,
    tradesWithPreMarketExitDetails: actualTrades
      .filter(trade => trade.preMarketExitDetails?.orderPlaced)
      .map(trade => ({
        date: trade.date,
        type: trade.type,
        entryPrice: trade.entry.price,
        exitPrice: trade.exit.price,
        exitReason: trade.exit.reason,
        preMarketOrderPlacementTime: trade.preMarketExitDetails.orderPlacementTime,
        preMarketOrderPlacementPrice: trade.preMarketExitDetails.orderPlacementPrice,
        preMarketOrderFilled: trade.preMarketExitDetails.orderFilled,
        preMarketOrderFillTime: trade.preMarketExitDetails.orderFillTime,
        preMarketOrderFillPrice: trade.preMarketExitDetails.orderFillPrice,
        candleGapBetweenPlaceAndFill: trade.preMarketExitDetails.orderFilled ? 
          trade.preMarketExitDetails.orderFillCandleIndex - trade.preMarketExitDetails.orderPlacementCandleIndex : null,
        // Dynamic pricing details
        dynamicPriceAdjustment: trade.preMarketExitDetails.dynamicPriceAdjustment,
        totalPriceUpdates: trade.preMarketExitDetails.totalPriceUpdates,
        priceUpdateHistory: trade.preMarketExitDetails.priceUpdateHistory,
        originalLimitPrice: trade.preMarketExitDetails.originalLimitPrice,
        finalLimitPrice: trade.preMarketExitDetails.finalLimitPrice,
        priceImprovement: trade.preMarketExitDetails.priceImprovement,
        priceImprovementVsForcedExit: trade.preMarketExitDetails.priceImprovementVsForcedExit,
        grossProfit: trade.grossProfit,
        netProfit: trade.netProfit
      }))
  };
  
  fs.writeFileSync('dynamic_pre_market_exit_analysis.json', JSON.stringify(preMarketExitData, null, 2));
  console.log('Dynamic pre-market exit analysis written to dynamic_pre_market_exit_analysis.json');
}