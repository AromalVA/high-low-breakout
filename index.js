const { runBacktest } = require('./trading-strategy');
const fs = require('fs');

// Configuration for the backtest
const config = {
  threshold: 70,  // Time threshold for breakout in minutes
  riskRewardRatio: 1.5,  // Risk to reward ratio
  pullbackPercentage: 10,  // Percentage of stop-loss points to wait for pullback (NEW)
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

// Print detailed breakdown of trades with breakout and entry times
console.log('\n=============== Trade Details Summary ===============');
const actualTrades = results.allTrades.filter(trade => trade.profit !== undefined || trade.netProfit !== undefined);
if (actualTrades.length > 0) {
  console.log('Sample trades with timing details:');
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
      console.log(`  Exit: ${trade.exit.reason} at ₹${trade.exit.price.toFixed(2)}`);
      console.log(`  Net Profit: ₹${(trade.netProfit || trade.profit || 0).toFixed(2)}`);
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

console.log('======================================================');

// Write results to a file
fs.writeFileSync('backtest_results.json', JSON.stringify(results, null, 2));
console.log('Detailed results written to backtest_results.json');