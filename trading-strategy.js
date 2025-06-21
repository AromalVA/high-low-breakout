const fs = require('fs');

/**
 * Default configuration for the backtest
 */
const defaultConfig = {
  minThreshold: 60, // Minimum time threshold for breakout in minutes
  maxThreshold: 180, // Maximum time threshold for breakout in minutes
  riskRewardRatio: 1,
  pullbackPercentage: 10, // Percentage of stop-loss points to wait for pullback
  minimumStopLossPercent: 0.5, // Minimum stop loss as percentage of current price
  entryTimeRange: {
    enabled: false, // Whether to restrict entry times
    startTime: "10:15", // Entry allowed from this time (24-hour format HH:MM)
    endTime: "14:00"   // Entry allowed until this time (24-hour format HH:MM)
  },
  marketExitTime: {
    enabled: false, // Whether to force exit at specific time
    exitTime: "15:00", // Force exit at this time (24-hour format HH:MM)
    preExitLimitOrderMinutes: 10, // Place limit order X minutes before market exit time
    dynamicPriceAdjustment: true // Enable dynamic price adjustment
  },
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
    volumeMultiplier: 3,
    lookbackPeriod: 5
  },
  capital: {
    initial: 100000, // Initial capital
    utilizationPercent: 100, // Use 100% of capital by default
    leverage: 5, // 5x leverage
    brokerageFeePercent: 0.06 // 0.06% brokerage fee
  },
  stopLossExitConfig: {
    enabled: true, // Whether to use dynamic stop loss exit
    dynamicStopLossAdjustment: true, // Enable dynamic stop loss price adjustment
    maxLossPercent: 200, // Force market exit if loss exceeds this % of stop loss (circuit breaker)
    forceMarketOrderAfterMax: true, // Use market order as circuit breaker when maxLossPercent is hit
    description: "Wait for actual SL breach, place limit order at breach candle close, skip one candle, then check for fill"
  },
  targetExitConfig: {
    enabled: true, // Enable dynamic target exit with limit orders
    dynamicTargetAdjustment: true, // Enable dynamic target price adjustment
    description: "Place limit order when target hit, skip one candle, then check for fill"
  },
  entryOrderConfig: {
    enabled: true, // Enable dynamic entry with limit orders
    dynamicEntryAdjustment: true, // Enable dynamic entry price adjustment
    description: "Place limit order when pullback hit, skip one candle, then check for fill"
  },
  priceRounding: {
    enabled: true, // Enable price rounding to nearest 0.05
    tickSize: 0.05 // Round to nearest 0.05 rupees
  }
};

/**
 * Get the body high of a candle (avoiding upper wick)
 * @param {Object} candle - Candle object with open, high, low, close
 * @returns {number} - The highest price of the candle body
 */
function getCandleBodyHigh(candle) {
  return Math.max(candle.open, candle.close);
}

/**
 * Get the body low of a candle (avoiding lower wick)
 * @param {Object} candle - Candle object with open, high, low, close
 * @returns {number} - The lowest price of the candle body
 */
function getCandleBodyLow(candle) {
  return Math.min(candle.open, candle.close);
}

/**
 * Round price to the nearest tick size (0.05 by default for Indian markets)
 * @param {number} price - The price to round
 * @param {number} tickSize - The tick size (default 0.05)
 * @returns {number} - Rounded price
 */
function roundToTickSize(price, tickSize = 0.05) {
  if (!price || isNaN(price)) return price;
  return Math.round(price / tickSize) * tickSize;
}

/**
 * Apply price rounding based on configuration
 * @param {number} price - The price to round
 * @param {Object} config - Configuration object
 * @returns {number} - Rounded price if enabled, original price otherwise
 */
function applyPriceRounding(price, config) {
  if (config.priceRounding?.enabled) {
    return roundToTickSize(price, config.priceRounding.tickSize);
  }
  return price;
}

/**
 * Check if stop loss percentage meets minimum requirements
 * @param {number} currentPrice - Current breakout price
 * @param {number} stopLossPrice - Calculated stop loss price
 * @param {Object} config - Configuration object
 * @returns {Object} - Validation result with passed status, reason, and data
 */
function isMinimumStopLossPercentMet(currentPrice, stopLossPrice, config) {
  if (!config.minimumStopLossPercent || config.minimumStopLossPercent <= 0) {
    return { passed: true, reason: "Minimum stop loss percentage validation disabled", data: null };
  }

  const actualStopLossPoints = Math.abs(currentPrice - stopLossPrice);
  const actualStopLossPercent = (actualStopLossPoints / currentPrice) * 100;
  const minimumRequiredPercent = config.minimumStopLossPercent;
  const minimumRequiredPoints = (currentPrice * minimumRequiredPercent) / 100;

  return {
    passed: actualStopLossPercent >= minimumRequiredPercent,
    reason: actualStopLossPercent >= minimumRequiredPercent ?
      "Minimum stop loss percentage requirement met" : "Stop loss too tight - below minimum percentage requirement",
    data: {
      currentPrice: currentPrice,
      stopLossPrice: stopLossPrice,
      actualStopLossPoints: actualStopLossPoints,
      actualStopLossPercent: actualStopLossPercent,
      minimumRequiredPercent: minimumRequiredPercent,
      minimumRequiredPoints: minimumRequiredPoints,
      difference: actualStopLossPercent - minimumRequiredPercent
    }
  };
}

/**
 * Parse time from timestamp into minutes for time difference calculation
 * @param {string} timestamp - Timestamp in format "DD/MM/YYYY HH:MM AM/PM"
 * @returns {number} - Minutes since midnight
 */
function parseTimeToMinutes(timestamp) {
  const parts = timestamp.split(' ');
  const timePart = parts[1];
  const meridiem = parts[2];

  let [hours, minutes] = timePart.split(':').map(part => parseInt(part, 10));

  // Convert to 24-hour format
  if (meridiem === 'PM' && hours < 12) {
    hours += 12;
  } else if (meridiem === 'AM' && hours === 12) {
    hours = 0;
  }

  return hours * 60 + minutes;
}

/**
 * Parse 24-hour format time string to minutes since midnight
 * @param {string} timeStr - Time string in format "HH:MM" (24-hour format)
 * @returns {number} - Minutes since midnight
 */
function parse24HourTimeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(part => parseInt(part, 10));
  return hours * 60 + minutes;
}

/**
 * Check if current time is within entry time range
 * @param {string} timestamp - Current timestamp in format "DD/MM/YYYY HH:MM AM/PM"
 * @param {Object} config - Configuration with entryTimeRange settings
 * @returns {boolean} - Whether entry is allowed at this time
 */
function isEntryTimeAllowed(timestamp, config) {
  if (!config.entryTimeRange.enabled) {
    return true;
  }

  const currentTimeMinutes = parseTimeToMinutes(timestamp);
  const startTimeMinutes = parse24HourTimeToMinutes(config.entryTimeRange.startTime);
  const endTimeMinutes = parse24HourTimeToMinutes(config.entryTimeRange.endTime);

  return currentTimeMinutes >= startTimeMinutes && currentTimeMinutes <= endTimeMinutes;
}

/**
 * Check if current time has reached the pre-market exit time (for placing limit orders)
 * @param {string} timestamp - Current timestamp in format "DD/MM/YYYY HH:MM AM/PM"
 * @param {Object} config - Configuration with marketExitTime settings
 * @returns {boolean} - Whether it's time to place pre-market exit limit order
 */
function shouldPlacePreMarketExitOrder(timestamp, config) {
  if (!config.marketExitTime.enabled) {
    return false;
  }

  const currentTimeMinutes = parseTimeToMinutes(timestamp);
  const exitTimeMinutes = parse24HourTimeToMinutes(config.marketExitTime.exitTime);
  const preExitMinutes = config.marketExitTime.preExitLimitOrderMinutes || 10;
  const preExitTimeMinutes = exitTimeMinutes - preExitMinutes;

  return currentTimeMinutes >= preExitTimeMinutes;
}

/**
 * Check if current time has reached market exit time
 * @param {string} timestamp - Current timestamp in format "DD/MM/YYYY HH:MM AM/PM"
 * @param {Object} config - Configuration with marketExitTime settings
 * @returns {boolean} - Whether it's time to force exit
 */
function shouldForceMarketExit(timestamp, config) {
  if (!config.marketExitTime.enabled) {
    return false;
  }

  const currentTimeMinutes = parseTimeToMinutes(timestamp);
  const exitTimeMinutes = parse24HourTimeToMinutes(config.marketExitTime.exitTime);

  return currentTimeMinutes >= exitTimeMinutes;
}

/**
 * Check if time difference is within the allowed threshold range
 * @param {number} timeDiff - Time difference in minutes
 * @param {Object} config - Configuration with min/max threshold settings
 * @returns {boolean} - Whether time difference is within allowed range
 */
function isTimeThresholdMet(timeDiff, config) {
  return timeDiff >= config.minThreshold && timeDiff <= config.maxThreshold;
}

/**
 * Calculate the time difference in minutes between two timestamps
 * @param {string} timestamp1 - First timestamp
 * @param {string} timestamp2 - Second timestamp
 * @returns {number} - Time difference in minutes
 */
function calculateTimeDiffInMinutes(timestamp1, timestamp2) {
  const minutes1 = parseTimeToMinutes(timestamp1);
  const minutes2 = parseTimeToMinutes(timestamp2);

  return Math.abs(minutes2 - minutes1);
}

/**
 * Parse the date string in DD/MM/YYYY format to a Date object
 * @param {string} dateStr - Date string in DD/MM/YYYY format
 * @returns {Date} - Date object
 */
function parseDate(dateStr) {
  const [day, month, year] = dateStr.split('/').map(part => parseInt(part, 10));
  return new Date(year, month - 1, day);
}

/**
 * Format timestamp from DD/MM/YYYY HH:MM AM/PM to YYYY-MM-DD HH:MM
 * @param {string} timestamp - Timestamp in format "DD/MM/YYYY HH:MM AM/PM"
 * @returns {string} - Formatted timestamp "YYYY-MM-DD HH:MM"
 */
function formatTimestamp(timestamp) {
  const parts = timestamp.split(' ');
  const datePart = parts[0];
  const timePart = parts[1];
  const meridiem = parts[2];

  // Parse date
  const [day, month, year] = datePart.split('/').map(part => parseInt(part, 10));

  // Parse time
  let [hours, minutes] = timePart.split(':').map(part => parseInt(part, 10));

  // Convert to 24-hour format
  if (meridiem === 'PM' && hours < 12) {
    hours += 12;
  } else if (meridiem === 'AM' && hours === 12) {
    hours = 0;
  }

  // Format to YYYY-MM-DD HH:MM
  const formattedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const formattedTime = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  return `${formattedDate} ${formattedTime}`;
}

/**
 * Check if a date should be included based on dateFilter config
 * @param {string} dateStr - Date string in DD/MM/YYYY format
 * @param {Object} config - Configuration object with dateFilter
 * @returns {boolean} - Whether the date should be included
 */
function shouldIncludeDate(dateStr, config) {
  if (!config.dateFilter.enabled) {
    return true;
  }

  const date = parseDate(dateStr);

  if (config.dateFilter.specificDate) {
    const specificDate = parseDate(config.dateFilter.specificDate);
    return date.getTime() === specificDate.getTime();
  }

  if (config.dateFilter.dateRange.start && config.dateFilter.dateRange.end) {
    const startDate = parseDate(config.dateFilter.dateRange.start);
    const endDate = parseDate(config.dateFilter.dateRange.end);
    return date >= startDate && date <= endDate;
  }

  return true;
}

/**
 * Check if volume confirmation is met
 * @param {Array} data - Candle data array
 * @param {number} currentIndex - Index of the current candle
 * @param {Object} config - Configuration with volumeConfirmation settings
 * @returns {Object} - Volume confirmation result with passed status, reason, and data
 */
function isVolumeConfirmationMet(data, currentIndex, config) {
  if (!config.volumeConfirmation.enabled) {
    return { passed: true, reason: "Volume confirmation disabled", data: null };
  }

  // Get the pre-breakout candle (the candle right before the current one)
  const preBreakoutCandleIndex = currentIndex - 1;

  if (preBreakoutCandleIndex < 0 || preBreakoutCandleIndex >= data.length) {
    return { passed: true, reason: "Pre-breakout candle not available", data: null };
  }

  const preBreakoutCandle = data[preBreakoutCandleIndex];

  // Calculate the average volume of the lookback period
  let totalVolume = 0;
  let count = 0;

  // Start from the candle before the pre-breakout candle
  for (let i = preBreakoutCandleIndex - 1; i >= Math.max(0, preBreakoutCandleIndex - config.volumeConfirmation.lookbackPeriod); i--) {
    totalVolume += data[i].volume;
    count++;
  }

  const averageVolume = count > 0 ? totalVolume / count : 0;
  const volumeThreshold = averageVolume * config.volumeConfirmation.volumeMultiplier;

  return {
    passed: preBreakoutCandle.volume >= volumeThreshold,
    reason: preBreakoutCandle.volume >= volumeThreshold ?
      "Volume confirmation passed" : "Volume confirmation failed",
    data: {
      preBreakoutCandleTime: preBreakoutCandle.timestamp_readable_IST,
      preBreakoutVolume: preBreakoutCandle.volume,
      averageVolume: averageVolume,
      volumeThreshold: volumeThreshold,
      volumeMultiplier: config.volumeConfirmation.volumeMultiplier
    }
  };
}

/**
 * Analyze a trading day with the given strategy (with pullback entry and minimum stop loss validation)
 * @param {string} date - Date string in DD/MM/YYYY format
 * @param {Array} dayData - Candle data for the day
 * @param {Object} config - Configuration object
 * @returns {Object} - Trade information for the day
 */
function analyzeTradingDay(date, dayData, config) {
  if (!dayData || dayData.length === 0) {
    return {
      date,
      message: "No data available for this date",
      volumeRejection: false,
      volumeData: null,
      minimumStopLossRejection: false,
      minimumStopLossData: null
    };
  }

  // Initialize tracking variables - NOW USING BODY PRICES (AVOIDING WICKS)
  let previousHighTime = dayData[0].timestamp_readable_IST;
  let previousHighPrice = getCandleBodyHigh(dayData[0]); // Use body high instead of high
  let previousLowTime = dayData[0].timestamp_readable_IST;
  let previousLowPrice = getCandleBodyLow(dayData[0]); // Use body low instead of low

  // Track the lowest point since the last high and highest point since the last low - USING BODY PRICES
  let lowestSinceLastHigh = getCandleBodyLow(dayData[0]);
  let lowestSinceLastHighTime = dayData[0].timestamp_readable_IST;
  let highestSinceLastLow = getCandleBodyHigh(dayData[0]);
  let highestSinceLastLowTime = dayData[0].timestamp_readable_IST;

  // Track pending breakouts waiting for pullback
  let pendingLongBreakout = null;
  let pendingShortBreakout = null;

  // Track pending entry orders with skip-one-candle logic
  let pendingLongEntryOrder = null;
  let pendingShortEntryOrder = null;

  let longEntry = null;
  let shortEntry = null;

  // Track invalid breakouts encountered during the day
  let invalidBreakouts = [];

  // Initialize patterns array
  let patterns = [];

  for (let i = 1; i < dayData.length; i++) {
    const candle = dayData[i];

    // Update lowest since last high and highest since last low - USING BODY PRICES
    const currentBodyLow = getCandleBodyLow(candle);
    const currentBodyHigh = getCandleBodyHigh(candle);

    if (currentBodyLow < lowestSinceLastHigh) {
      lowestSinceLastHigh = currentBodyLow;
      lowestSinceLastHighTime = candle.timestamp_readable_IST;
    }

    if (currentBodyHigh > highestSinceLastLow) {
      highestSinceLastLow = currentBodyHigh;
      highestSinceLastLowTime = candle.timestamp_readable_IST;
    }

    // Check for candlestick patterns
    const prevCandle = i > 0 ? dayData[i - 1] : null;
    if (prevCandle) {
      // Check for hammer pattern (potential reversal)
      if (candle.close > candle.open && // Bullish candle
        (candle.high - candle.close) < (candle.open - candle.low) * 0.5 && // Small upper shadow
        (candle.open - candle.low) > (candle.close - candle.open) * 2) { // Long lower shadow
        patterns.push("hammer");
      }
    }

    // Check if we have a pending long breakout and look for pullback entry
    if (pendingLongBreakout && !longEntry && !pendingLongEntryOrder) {
      // Check if price has pulled back to our entry level AND closing price is below pullback target
      if (candle.low <= pendingLongBreakout.pullbackEntryPrice &&
        candle.close < pendingLongBreakout.pullbackEntryPrice) {
        if (isEntryTimeAllowed(candle.timestamp_readable_IST, config)) {
          // Place limit buy order at rounded closing price
          const roundedClosePrice = applyPriceRounding(candle.close, config);
          pendingLongEntryOrder = {
            price: roundedClosePrice,
            originalPrice: roundedClosePrice,
            placedTime: formatTimestamp(candle.timestamp_readable_IST),
            placedAtCandle: i,
            priceUpdates: [],
            breakoutInfo: pendingLongBreakout
          };
        } else {
          // Pullback hit but entry time not allowed - reject this breakout
          pendingLongBreakout = null;
        }
      }
    }

    // Check if we have a pending short breakout and look for pullback entry
    if (pendingShortBreakout && !shortEntry && !pendingShortEntryOrder) {
      // Check if price has pulled back to our entry level AND closing price is above pullback target
      if (candle.high >= pendingShortBreakout.pullbackEntryPrice &&
        candle.close > pendingShortBreakout.pullbackEntryPrice) {
        if (isEntryTimeAllowed(candle.timestamp_readable_IST, config)) {
          // Place limit sell order at rounded closing price
          const roundedClosePrice = applyPriceRounding(candle.close, config);
          pendingShortEntryOrder = {
            price: roundedClosePrice,
            originalPrice: roundedClosePrice,
            placedTime: formatTimestamp(candle.timestamp_readable_IST),
            placedAtCandle: i,
            priceUpdates: [],
            breakoutInfo: pendingShortBreakout
          };
        } else {
          // Pullback hit but entry time not allowed - reject this breakout
          pendingShortBreakout = null;
        }
      }
    }

    // Check if pending long entry order should be filled or updated (skip one candle)
    if (pendingLongEntryOrder && !longEntry && i > pendingLongEntryOrder.placedAtCandle + 1) {
      // Check if entry time is still allowed
      if (!isEntryTimeAllowed(candle.timestamp_readable_IST, config)) {
        // Entry time window closed - cancel pending orders
        pendingLongEntryOrder = null;
        pendingLongBreakout = null;
      } else {
        // Check if current candle fills the existing limit buy order
        if (candle.low <= pendingLongEntryOrder.price) {
          // Order filled - create the trade
          longEntry = {
            type: "long",
            entry: {
              price: pendingLongEntryOrder.price,
              time: formatTimestamp(candle.timestamp_readable_IST)
            },
            target: pendingLongEntryOrder.breakoutInfo.target,
            stopLoss: pendingLongEntryOrder.breakoutInfo.stopLoss,
            patterns: [...patterns],
            volumeInfo: pendingLongEntryOrder.breakoutInfo.volumeInfo,
            breakoutDetails: {
              ...pendingLongEntryOrder.breakoutInfo.breakoutDetails,
              actualEntryTime: formatTimestamp(candle.timestamp_readable_IST),
              actualEntryPrice: pendingLongEntryOrder.price,
              pullbackPercentage: config.pullbackPercentage,
              entryOrderDetails: {
                orderPlacedTime: pendingLongEntryOrder.placedTime,
                orderPlacedAtCandle: pendingLongEntryOrder.placedAtCandle,
                originalOrderPrice: pendingLongEntryOrder.originalPrice,
                finalOrderPrice: pendingLongEntryOrder.price,
                priceUpdates: pendingLongEntryOrder.priceUpdates,
                skipOneCandleLogic: true
              }
            }
          };
          // Clear the breakout and entry order
          pendingLongBreakout = null;
          pendingLongEntryOrder = null;
        } else {
          // Order not filled - update limit order to current rounded close if better (lower for long)
          const oldPrice = pendingLongEntryOrder.price;
          const newPrice = applyPriceRounding(candle.close, config);

          // Only update if dynamic adjustment enabled, price is better (lower for long positions) and meaningful change
          if (config.entryOrderConfig?.dynamicEntryAdjustment &&
            newPrice < oldPrice && Math.abs(newPrice - oldPrice) >= 0.05) {
            const priceUpdate = {
              candleIndex: i,
              time: formatTimestamp(candle.timestamp_readable_IST),
              oldPrice: oldPrice,
              newPrice: newPrice,
              candleHigh: candle.high,
              candleLow: candle.low,
              candleClose: candle.close,
              reason: "dynamic_entry_adjustment"
            };

            pendingLongEntryOrder.price = newPrice;
            pendingLongEntryOrder.priceUpdates.push(priceUpdate);
          }
        }
      }
    }

    // Check if pending short entry order should be filled or updated (skip one candle)
    if (pendingShortEntryOrder && !shortEntry && i > pendingShortEntryOrder.placedAtCandle + 1) {
      // Check if entry time is still allowed
      if (!isEntryTimeAllowed(candle.timestamp_readable_IST, config)) {
        // Entry time window closed - cancel pending orders
        pendingShortEntryOrder = null;
        pendingShortBreakout = null;
      } else {
        // Check if current candle fills the existing limit sell order
        if (candle.high >= pendingShortEntryOrder.price) {
          // Order filled - create the trade
          shortEntry = {
            type: "short",
            entry: {
              price: pendingShortEntryOrder.price,
              time: formatTimestamp(candle.timestamp_readable_IST)
            },
            target: pendingShortEntryOrder.breakoutInfo.target,
            stopLoss: pendingShortEntryOrder.breakoutInfo.stopLoss,
            patterns: [...patterns],
            volumeInfo: pendingShortEntryOrder.breakoutInfo.volumeInfo,
            breakoutDetails: {
              ...pendingShortEntryOrder.breakoutInfo.breakoutDetails,
              actualEntryTime: formatTimestamp(candle.timestamp_readable_IST),
              actualEntryPrice: pendingShortEntryOrder.price,
              pullbackPercentage: config.pullbackPercentage,
              entryOrderDetails: {
                orderPlacedTime: pendingShortEntryOrder.placedTime,
                orderPlacedAtCandle: pendingShortEntryOrder.placedAtCandle,
                originalOrderPrice: pendingShortEntryOrder.originalPrice,
                finalOrderPrice: pendingShortEntryOrder.price,
                priceUpdates: pendingShortEntryOrder.priceUpdates,
                skipOneCandleLogic: true
              }
            }
          };
          // Clear the breakout and entry order
          pendingShortBreakout = null;
          pendingShortEntryOrder = null;
        } else {
          // Order not filled - update limit order to current rounded close if better (higher for short)
          const oldPrice = pendingShortEntryOrder.price;
          const newPrice = applyPriceRounding(candle.close, config);

          // Only update if dynamic adjustment enabled, price is better (higher for short positions) and meaningful change
          if (config.entryOrderConfig?.dynamicEntryAdjustment &&
            newPrice > oldPrice && Math.abs(newPrice - oldPrice) >= 0.05) {
            const priceUpdate = {
              candleIndex: i,
              time: formatTimestamp(candle.timestamp_readable_IST),
              oldPrice: oldPrice,
              newPrice: newPrice,
              candleHigh: candle.high,
              candleLow: candle.low,
              candleClose: candle.close,
              reason: "dynamic_entry_adjustment"
            };

            pendingShortEntryOrder.price = newPrice;
            pendingShortEntryOrder.priceUpdates.push(priceUpdate);
          }
        }
      }
    }

    // Check for new high (must be STRICTLY higher than previous high) - USING BODY HIGH
    if (currentBodyHigh > previousHighPrice + 0.05) { // Using a small threshold to account for precision issues
      const timeDiff = calculateTimeDiffInMinutes(candle.timestamp_readable_IST, previousHighTime);

      if (isTimeThresholdMet(timeDiff, config) && !pendingLongBreakout && !longEntry) {
        // We have a valid high breakout with time difference within the allowed range
        const volumeConfirmation = isVolumeConfirmationMet(dayData, i, config);

        if (volumeConfirmation.passed) {
          // Calculate target and stop loss for long entry with price rounding
          const breakoutPrice = applyPriceRounding(previousHighPrice, config);
          const stopLoss = applyPriceRounding(lowestSinceLastHigh, config);

          // NEW: Check minimum stop loss percentage requirement
          const minimumStopLossValidation = isMinimumStopLossPercentMet(breakoutPrice, stopLoss, config);

          if (minimumStopLossValidation.passed) {
            const risk = breakoutPrice - stopLoss;
            const target = applyPriceRounding(breakoutPrice + (risk * config.riskRewardRatio), config);

            // Calculate pullback entry price with rounding
            const pullbackAmount = risk * (config.pullbackPercentage / 100);
            const pullbackEntryPrice = applyPriceRounding(breakoutPrice - pullbackAmount, config);

            pendingLongBreakout = {
              type: "long",
              breakoutPrice: breakoutPrice,
              pullbackEntryPrice: pullbackEntryPrice,
              target: target,
              stopLoss: stopLoss,
              patterns: [...patterns],
              volumeInfo: {
                breakoutCandleVolume: candle.volume,
                confirmationCandleVolume: dayData[i - 1].volume,
                averageLookbackVolume: volumeConfirmation.data ? volumeConfirmation.data.averageVolume : null,
                volumeConfirmationEnabled: config.volumeConfirmation.enabled,
                volumeConfirmationPassed: volumeConfirmation.passed,
                volumeConfirmationReason: volumeConfirmation.reason
              },
              breakoutDetails: {
                breakoutTime: formatTimestamp(candle.timestamp_readable_IST),
                breakoutPrice: breakoutPrice,
                previousExtremeTime: formatTimestamp(previousHighTime),
                timeSincePreviousExtreme: timeDiff,
                previousExtremeType: "high",
                minThresholdRequired: config.minThreshold,
                maxThresholdRequired: config.maxThreshold,
                stopLossValue: stopLoss,
                stopLossTime: formatTimestamp(lowestSinceLastHighTime),
                swingLow: lowestSinceLastHigh,
                swingHigh: previousHighPrice,
                volumeConfirmation: volumeConfirmation,
                minimumStopLossValidation: minimumStopLossValidation,
                pullbackEntryPrice: pullbackEntryPrice,
                pullbackAmount: pullbackAmount,
                useBodyPricesOnly: true // Indicate that we're avoiding wicks
              }
            };
          } else {
            // Stop loss too tight - record this rejection
            return {
              date,
              message: `Breakout detected but stop loss too tight (${minimumStopLossValidation.data.actualStopLossPercent.toFixed(2)}% < ${config.minimumStopLossPercent}%)`,
              breakoutDetected: true,
              breakoutType: "long",
              breakoutTime: formatTimestamp(candle.timestamp_readable_IST),
              breakoutPrice: breakoutPrice,
              volumeRejection: false,
              volumeData: null,
              minimumStopLossRejection: true,
              minimumStopLossData: minimumStopLossValidation.data,
              useBodyPricesOnly: true
            };
          }
        }
      }

      // Record invalid breakouts for reporting if no valid trades found
      if (!isTimeThresholdMet(timeDiff, config)) {
        invalidBreakouts.push({
          type: "long",
          breakoutTime: formatTimestamp(candle.timestamp_readable_IST),
          breakoutPrice: applyPriceRounding(previousHighPrice, config),
          timeGap: timeDiff,
          requiredTimeRange: `${config.minThreshold}-${config.maxThreshold}`
        });
      }

      // Update previous high and reset lowest since last high - USING BODY PRICES
      previousHighPrice = currentBodyHigh;
      previousHighTime = candle.timestamp_readable_IST;
      lowestSinceLastHigh = currentBodyLow;
      lowestSinceLastHighTime = candle.timestamp_readable_IST;
    }

    // Check for new low (must be STRICTLY lower than previous low) - USING BODY LOW
    if (currentBodyLow < previousLowPrice - 0.05) { // Using a small threshold to account for precision issues
      const timeDiff = calculateTimeDiffInMinutes(candle.timestamp_readable_IST, previousLowTime);

      if (isTimeThresholdMet(timeDiff, config) && !pendingShortBreakout && !shortEntry) {
        // We have a valid low breakout with time difference within the allowed range
        const volumeConfirmation = isVolumeConfirmationMet(dayData, i, config);

        if (volumeConfirmation.passed) {
          // Calculate target and stop loss for short entry with price rounding
          const breakoutPrice = applyPriceRounding(previousLowPrice, config);
          const stopLoss = applyPriceRounding(highestSinceLastLow, config);

          // NEW: Check minimum stop loss percentage requirement
          const minimumStopLossValidation = isMinimumStopLossPercentMet(breakoutPrice, stopLoss, config);

          if (minimumStopLossValidation.passed) {
            const risk = stopLoss - breakoutPrice;
            const target = applyPriceRounding(breakoutPrice - (risk * config.riskRewardRatio), config);

            // Calculate pullback entry price with rounding
            const pullbackAmount = risk * (config.pullbackPercentage / 100);
            const pullbackEntryPrice = applyPriceRounding(breakoutPrice + pullbackAmount, config);

            pendingShortBreakout = {
              type: "short",
              breakoutPrice: breakoutPrice,
              pullbackEntryPrice: pullbackEntryPrice,
              target: target,
              stopLoss: stopLoss,
              patterns: [...patterns],
              volumeInfo: {
                breakoutCandleVolume: candle.volume,
                confirmationCandleVolume: dayData[i - 1].volume,
                averageLookbackVolume: volumeConfirmation.data ? volumeConfirmation.data.averageVolume : null,
                volumeConfirmationEnabled: config.volumeConfirmation.enabled,
                volumeConfirmationPassed: volumeConfirmation.passed,
                volumeConfirmationReason: volumeConfirmation.reason
              },
              breakoutDetails: {
                breakoutTime: formatTimestamp(candle.timestamp_readable_IST),
                breakoutPrice: breakoutPrice,
                previousExtremeTime: formatTimestamp(previousLowTime),
                timeSincePreviousExtreme: timeDiff,
                previousExtremeType: "low",
                minThresholdRequired: config.minThreshold,
                maxThresholdRequired: config.maxThreshold,
                stopLossValue: stopLoss,
                stopLossTime: formatTimestamp(highestSinceLastLowTime),
                swingLow: previousLowPrice,
                swingHigh: highestSinceLastLow,
                volumeConfirmation: volumeConfirmation,
                minimumStopLossValidation: minimumStopLossValidation,
                pullbackEntryPrice: pullbackEntryPrice,
                pullbackAmount: pullbackAmount,
                useBodyPricesOnly: true // Indicate that we're avoiding wicks
              }
            };
          } else {
            // Stop loss too tight - record this rejection
            return {
              date,
              message: `Breakout detected but stop loss too tight (${minimumStopLossValidation.data.actualStopLossPercent.toFixed(2)}% < ${config.minimumStopLossPercent}%)`,
              breakoutDetected: true,
              breakoutType: "short",
              breakoutTime: formatTimestamp(candle.timestamp_readable_IST),
              breakoutPrice: breakoutPrice,
              volumeRejection: false,
              volumeData: null,
              minimumStopLossRejection: true,
              minimumStopLossData: minimumStopLossValidation.data,
              useBodyPricesOnly: true
            };
          }
        }
      }

      // Record invalid breakouts for reporting if no valid trades found
      if (!isTimeThresholdMet(timeDiff, config)) {
        invalidBreakouts.push({
          type: "short",
          breakoutTime: formatTimestamp(candle.timestamp_readable_IST),
          breakoutPrice: applyPriceRounding(previousLowPrice, config),
          timeGap: timeDiff,
          requiredTimeRange: `${config.minThreshold}-${config.maxThreshold}`
        });
      }

      // Update previous low and reset highest since last low - USING BODY PRICES
      previousLowPrice = currentBodyLow;
      previousLowTime = candle.timestamp_readable_IST;
      highestSinceLastLow = currentBodyHigh;
      highestSinceLastLowTime = candle.timestamp_readable_IST;
    }
  }

  // If we have a long or short entry, simulate the trade and return results
  if (longEntry || shortEntry) {
    const entry = longEntry || shortEntry;
    return simulateTrade(date, entry, dayData, config.capital, config);
  }

  // Check if we have a breakout but no pullback entry
  if (pendingLongBreakout || pendingShortBreakout) {
    const pendingBreakout = pendingLongBreakout || pendingShortBreakout;
    return {
      date,
      message: `Breakout detected but no pullback entry (${pendingBreakout.type})`,
      breakoutDetected: true,
      breakoutType: pendingBreakout.type,
      breakoutTime: pendingBreakout.breakoutDetails.breakoutTime,
      breakoutPrice: pendingBreakout.breakoutPrice,
      requiredPullbackPrice: pendingBreakout.pullbackEntryPrice,
      volumeRejection: false,
      volumeData: null,
      minimumStopLossRejection: false,
      minimumStopLossData: null,
      useBodyPricesOnly: true // Indicate that we're avoiding wicks
    };
  }

  // Check if we have pending entry orders but no actual entry
  if (pendingLongEntryOrder || pendingShortEntryOrder) {
    const pendingEntryOrder = pendingLongEntryOrder || pendingShortEntryOrder;
    const breakoutInfo = pendingEntryOrder.breakoutInfo;
    return {
      date,
      message: `Entry order placed but not filled (${breakoutInfo.type})`,
      breakoutDetected: true,
      breakoutType: breakoutInfo.type,
      breakoutTime: breakoutInfo.breakoutDetails.breakoutTime,
      breakoutPrice: breakoutInfo.breakoutPrice,
      requiredPullbackPrice: breakoutInfo.pullbackEntryPrice,
      entryOrderPlaced: true,
      entryOrderPrice: pendingEntryOrder.price,
      entryOrderOriginalPrice: pendingEntryOrder.originalPrice,
      entryOrderPriceUpdates: pendingEntryOrder.priceUpdates.length,
      volumeRejection: false,
      volumeData: null,
      minimumStopLossRejection: false,
      minimumStopLossData: null,
      useBodyPricesOnly: true // Indicate that we're avoiding wicks
    };
  }

  // If we had invalid breakouts but no valid trades, report the first invalid breakout
  if (invalidBreakouts.length > 0) {
    const firstInvalidBreakout = invalidBreakouts[0];
    return {
      date,
      message: `Breakout detected but outside time threshold range (${firstInvalidBreakout.timeGap} mins)`,
      breakoutOutsideTimeRange: true,
      breakoutType: firstInvalidBreakout.type,
      breakoutTime: firstInvalidBreakout.breakoutTime,
      breakoutPrice: firstInvalidBreakout.breakoutPrice,
      timeGap: firstInvalidBreakout.timeGap,
      requiredTimeRange: firstInvalidBreakout.requiredTimeRange,
      volumeRejection: false,
      volumeData: null,
      minimumStopLossRejection: false,
      minimumStopLossData: null,
      useBodyPricesOnly: true // Indicate that we're avoiding wicks
    };
  }

  // No valid trades for this day
  return {
    date,
    message: "No valid breakout detected",
    volumeRejection: false,
    volumeData: null,
    minimumStopLossRejection: false,
    minimumStopLossData: null,
    useBodyPricesOnly: true // Indicate that we're avoiding wicks
  };
}

/**
 * Simulate a trade execution with skip-one-candle limit order logic for both stop loss and target exits
 * @param {string} date - The date of the trade
 * @param {Object} trade - The trade entry object
 * @param {Array} dayData - The candle data for the day
 * @param {Object} capital - Capital configuration with initial amount and utilization percent
 * @param {Object} config - Configuration object with time-based restrictions and exit configs
 * @returns {Object} - The trade result object
 */
function simulateTrade(date, trade, dayData, capital, config) {
  // Find the starting index (entry time)
  const entryTimeStr = trade.entry.time;
  let entryIndex = dayData.findIndex(candle => formatTimestamp(candle.timestamp_readable_IST) === entryTimeStr);

  if (entryIndex === -1) {
    // If exact match not found, find the closest time
    entryIndex = dayData.findIndex(candle => {
      const candleTime = parseTimeToMinutes(candle.timestamp_readable_IST);
      const entryTime = parseTimeToMinutes(entryTimeStr);
      return candleTime >= entryTime;
    });
  }

  if (entryIndex === -1) {
    return {
      date,
      message: "Could not find entry candle",
      volumeRejection: false,
      volumeData: null
    };
  }

  // Calculate how many shares we can buy with the available capital
  const availableCapital = capital.initial * (capital.utilizationPercent / 100);
  // Apply leverage
  const leveragedCapital = availableCapital * (capital.leverage || 1);
  // Only buy whole shares (no fractions)
  const maxShares = Math.floor(leveragedCapital / trade.entry.price);
  const investedAmount = maxShares * trade.entry.price;

  // Calculate entry brokerage fee
  const brokerageFeePercent = capital.brokerageFeePercent || 0;
  const entryBrokerageFee = (investedAmount * brokerageFeePercent) / 100;

  // Calculate risk in points
  const riskPoints = trade.type === "long" ?
    trade.entry.price - trade.stopLoss :
    trade.stopLoss - trade.entry.price;

  // Initialize stop loss exit tracking with skip-one-candle logic
  const stopLossConfig = config.stopLossExitConfig || { enabled: false };
  let stopLossBreach = false;
  let activeStopLossOrder = null;
  let stopLossExitDetails = {
    enabled: stopLossConfig.enabled,
    dynamicStopLossAdjustment: stopLossConfig.dynamicStopLossAdjustment || false,
    stopLossBreached: false,
    breachCandleTime: null,
    breachCandleClose: null,
    breachCandleIndex: null,
    limitOrderHistory: [],
    totalPriceUpdates: 0,
    originalLimitPrice: null,
    finalLimitPrice: null,
    finalExitPrice: null,
    finalExitReason: null,
    maxLossPercent: stopLossConfig.maxLossPercent,
    forceMarketOrderAfterMax: stopLossConfig.forceMarketOrderAfterMax,
    circuitBreakerTriggered: false,
    orderFillDetails: null,
    skipOneCandleLogic: true
  };

  // Initialize target exit tracking with skip-one-candle logic
  const targetConfig = config.targetExitConfig || { enabled: true };
  let targetHit = false;
  let activeTargetOrder = null;
  let targetExitDetails = {
    enabled: targetConfig.enabled,
    dynamicTargetAdjustment: targetConfig.dynamicTargetAdjustment || false,
    targetHit: false,
    hitCandleTime: null,
    hitCandleClose: null,
    hitCandleIndex: null,
    limitOrderHistory: [],
    totalPriceUpdates: 0,
    originalLimitPrice: null,
    finalLimitPrice: null,
    finalExitPrice: null,
    finalExitReason: null,
    orderFillDetails: null,
    skipOneCandleLogic: true
  };

  // Initialize dynamic pre-market exit order tracking with skip-one-candle logic
  let preMarketExitOrder = null;
  let preMarketExitDetails = {
    enabled: config.marketExitTime?.enabled || false,
    dynamicPriceAdjustment: config.marketExitTime?.dynamicPriceAdjustment || false,
    orderPlaced: false,
    orderPlacementTime: null,
    orderPlacementPrice: null,
    orderPlacementCandleIndex: null,
    orderFilled: false,
    orderFillTime: null,
    orderFillPrice: null,
    orderFillCandleIndex: null,
    preExitLimitOrderMinutes: config.marketExitTime?.preExitLimitOrderMinutes || 10,
    priceUpdateHistory: [],
    totalPriceUpdates: 0,
    originalLimitPrice: null,
    finalLimitPrice: null,
    priceImprovement: 0,
    priceImprovementVsForcedExit: 0,
    skipOneCandleLogic: true
  };

  // Track max favorable excursion
  let maxFavorableExcursion = 0;
  let exitPrice = null;
  let exitTime = null;
  let exitReason = null;

  // Start simulating from the next candle after entry
  for (let i = entryIndex + 1; i < dayData.length; i++) {
    const candle = dayData[i];

    // Check if we should place pre-market exit limit order
    if (config.marketExitTime?.enabled && !preMarketExitOrder &&
      shouldPlacePreMarketExitOrder(candle.timestamp_readable_IST, config)) {

      // Place initial limit order at the rounded closing price of this candle
      const roundedClosePrice = applyPriceRounding(candle.close, config);
      preMarketExitOrder = {
        price: roundedClosePrice,
        originalPrice: roundedClosePrice,
        placedTime: formatTimestamp(candle.timestamp_readable_IST),
        placedAtCandle: i,
        type: trade.type === "long" ? "sell" : "buy",
        priceUpdates: []
      };

      preMarketExitDetails.orderPlaced = true;
      preMarketExitDetails.orderPlacementTime = formatTimestamp(candle.timestamp_readable_IST);
      preMarketExitDetails.orderPlacementPrice = roundedClosePrice;
      preMarketExitDetails.orderPlacementCandleIndex = i;
      preMarketExitDetails.originalLimitPrice = roundedClosePrice;
    }

    // Check if pre-market exit limit order should be updated or filled (with skip-one-candle logic)
    if (preMarketExitOrder && !preMarketExitDetails.orderFilled &&
      i > preMarketExitOrder.placedAtCandle + 1) { // Skip one candle before checking

      let orderFilled = false;

      // Check if current candle fills the existing limit order
      if (trade.type === "long") {
        if (candle.high >= preMarketExitOrder.price) {
          orderFilled = true;
        }
      } else {
        if (candle.low <= preMarketExitOrder.price) {
          orderFilled = true;
        }
      }

      if (orderFilled) {
        // Order filled at current limit price
        exitPrice = preMarketExitOrder.price;
        exitTime = formatTimestamp(candle.timestamp_readable_IST);
        exitReason = "pre-market exit limit order filled";
        stopLossExitDetails.finalExitPrice = exitPrice;
        stopLossExitDetails.finalExitReason = exitReason;
        targetExitDetails.finalExitPrice = exitPrice;
        targetExitDetails.finalExitReason = exitReason;

        preMarketExitDetails.orderFilled = true;
        preMarketExitDetails.orderFillTime = formatTimestamp(candle.timestamp_readable_IST);
        preMarketExitDetails.orderFillPrice = preMarketExitOrder.price;
        preMarketExitDetails.orderFillCandleIndex = i;
        preMarketExitDetails.finalLimitPrice = preMarketExitOrder.price;

        preMarketExitDetails.priceImprovement = trade.type === "long" ?
          preMarketExitOrder.price - preMarketExitDetails.originalLimitPrice :
          preMarketExitDetails.originalLimitPrice - preMarketExitOrder.price;

        break;
      } else if (preMarketExitDetails.dynamicPriceAdjustment) {
        // Order not filled - UPDATE the limit order price to current candle's rounded close
        const oldPrice = preMarketExitOrder.price;
        const newPrice = applyPriceRounding(candle.close, config);

        if (Math.abs(newPrice - oldPrice) >= 0.05) { // Only update if change is meaningful (at least one tick)
          const priceUpdate = {
            candleIndex: i,
            time: formatTimestamp(candle.timestamp_readable_IST),
            oldPrice: oldPrice,
            newPrice: newPrice,
            candleHigh: candle.high,
            candleLow: candle.low,
            candleClose: candle.close,
            reason: "dynamic_price_adjustment"
          };

          preMarketExitOrder.price = newPrice;
          preMarketExitOrder.priceUpdates.push(priceUpdate);
          preMarketExitDetails.priceUpdateHistory.push(priceUpdate);
          preMarketExitDetails.totalPriceUpdates++;
        }
      }
    }

    // Check for forced market exit (fallback if pre-market exit order wasn't filled)
    if (shouldForceMarketExit(candle.timestamp_readable_IST, config)) {
      exitPrice = applyPriceRounding(candle.close, config);
      exitTime = formatTimestamp(candle.timestamp_readable_IST);
      exitReason = "forced market exit";
      stopLossExitDetails.finalExitPrice = exitPrice;
      stopLossExitDetails.finalExitReason = exitReason;
      targetExitDetails.finalExitPrice = exitPrice;
      targetExitDetails.finalExitReason = exitReason;

      if (preMarketExitOrder && !preMarketExitDetails.orderFilled) {
        preMarketExitDetails.finalLimitPrice = preMarketExitOrder.price;
        preMarketExitDetails.priceImprovement = trade.type === "long" ?
          preMarketExitOrder.price - preMarketExitDetails.originalLimitPrice :
          preMarketExitDetails.originalLimitPrice - preMarketExitOrder.price;
        preMarketExitDetails.priceImprovementVsForcedExit = trade.type === "long" ?
          preMarketExitOrder.price - exitPrice :
          exitPrice - preMarketExitOrder.price;
      }

      break;
    }

    // Calculate current profit/loss and update max favorable excursion
    let currentPnL = 0;
    if (trade.type === "long") {
      currentPnL = (candle.high - trade.entry.price) * maxShares;
      maxFavorableExcursion = Math.max(maxFavorableExcursion, currentPnL);

      // NEW: Check if target was hit with skip-one-candle limit order logic
      if (targetConfig.enabled && !targetHit && !activeTargetOrder && candle.high >= trade.target) {
        targetHit = true;
        targetExitDetails.targetHit = true;
        targetExitDetails.hitCandleTime = formatTimestamp(candle.timestamp_readable_IST);
        targetExitDetails.hitCandleClose = candle.close;
        targetExitDetails.hitCandleIndex = i;

        // Place limit sell order at rounded closing price
        const roundedClosePrice = applyPriceRounding(candle.close, config);
        activeTargetOrder = {
          price: roundedClosePrice,
          originalPrice: roundedClosePrice,
          placedTime: formatTimestamp(candle.timestamp_readable_IST),
          placedAtCandle: i,
          priceUpdates: []
        };

        targetExitDetails.originalLimitPrice = roundedClosePrice;
        targetExitDetails.limitOrderHistory.push({
          action: "placed",
          price: roundedClosePrice,
          time: formatTimestamp(candle.timestamp_readable_IST),
          candleIndex: i,
          reason: "target_hit"
        });
      }

      // Check if target limit order should be filled or updated (skip one candle)
      if (activeTargetOrder && i > activeTargetOrder.placedAtCandle + 1) {
        // Check if price moved above our limit order
        if (candle.high >= activeTargetOrder.price) {
          exitPrice = activeTargetOrder.price;
          exitTime = formatTimestamp(candle.timestamp_readable_IST);
          exitReason = "target limit order filled";
          stopLossExitDetails.finalExitPrice = exitPrice;
          stopLossExitDetails.finalExitReason = exitReason;
          targetExitDetails.finalExitPrice = exitPrice;
          targetExitDetails.finalExitReason = exitReason;
          targetExitDetails.finalLimitPrice = activeTargetOrder.price;

          targetExitDetails.orderFillDetails = {
            filledOrderPrice: activeTargetOrder.price,
            fillTime: formatTimestamp(candle.timestamp_readable_IST),
            fillCandleHigh: candle.high,
            fillCandleLow: candle.low,
            timeBetweenPlaceAndFill: calculateTimeDiffInMinutes(activeTargetOrder.placedTime, candle.timestamp_readable_IST),
            placedAtCandleIndex: activeTargetOrder.placedAtCandle,
            filledAtCandleIndex: i
          };

          break;
        } else if (targetExitDetails.dynamicTargetAdjustment) {
          // Price didn't reach target order, update limit order to current rounded close if better
          const oldPrice = activeTargetOrder.price;
          const newPrice = applyPriceRounding(candle.close, config);

          // Only update if price is better (higher for long positions) and meaningful change
          if (newPrice > oldPrice && Math.abs(newPrice - oldPrice) >= 0.05) {
            const priceUpdate = {
              candleIndex: i,
              time: formatTimestamp(candle.timestamp_readable_IST),
              oldPrice: oldPrice,
              newPrice: newPrice,
              candleHigh: candle.high,
              candleLow: candle.low,
              candleClose: candle.close,
              reason: "dynamic_target_adjustment"
            };

            activeTargetOrder.price = newPrice;
            activeTargetOrder.priceUpdates.push(priceUpdate);
            targetExitDetails.totalPriceUpdates++;
            targetExitDetails.limitOrderHistory.push({
              action: "updated",
              price: newPrice,
              time: formatTimestamp(candle.timestamp_readable_IST),
              candleIndex: i,
              reason: "dynamic_adjustment"
            });
          }
        }
      }

      // Stop loss logic with skip-one-candle logic
      if (stopLossConfig.enabled && !activeTargetOrder) { // Only check stop loss if target order not active
        // First, check if stop loss has been breached
        if (!stopLossBreach && candle.low <= trade.stopLoss) {
          stopLossBreach = true;
          stopLossExitDetails.stopLossBreached = true;
          stopLossExitDetails.breachCandleTime = formatTimestamp(candle.timestamp_readable_IST);
          stopLossExitDetails.breachCandleClose = candle.close;
          stopLossExitDetails.breachCandleIndex = i;

          // Place limit order at rounded closing price
          const roundedClosePrice = applyPriceRounding(candle.close, config);
          activeStopLossOrder = {
            price: roundedClosePrice,
            originalPrice: roundedClosePrice,
            placedTime: formatTimestamp(candle.timestamp_readable_IST),
            placedAtCandle: i,
            priceUpdates: []
          };

          stopLossExitDetails.originalLimitPrice = roundedClosePrice;
          stopLossExitDetails.limitOrderHistory.push({
            action: "placed",
            price: roundedClosePrice,
            time: formatTimestamp(candle.timestamp_readable_IST),
            candleIndex: i,
            reason: "stop_loss_breach"
          });
        }

        // If we have an active stop loss order, check if it should be filled or updated (skip one candle)
        if (activeStopLossOrder && i > activeStopLossOrder.placedAtCandle + 1) {
          // Check if price moved above our limit order (recovery)
          if (candle.high >= activeStopLossOrder.price) {
            exitPrice = activeStopLossOrder.price;
            exitTime = formatTimestamp(candle.timestamp_readable_IST);
            exitReason = "stop loss limit order filled";
            stopLossExitDetails.finalExitPrice = exitPrice;
            stopLossExitDetails.finalExitReason = exitReason;
            stopLossExitDetails.finalLimitPrice = activeStopLossOrder.price;
            targetExitDetails.finalExitPrice = exitPrice;
            targetExitDetails.finalExitReason = exitReason;

            stopLossExitDetails.orderFillDetails = {
              filledOrderPrice: activeStopLossOrder.price,
              fillTime: formatTimestamp(candle.timestamp_readable_IST),
              fillCandleHigh: candle.high,
              fillCandleLow: candle.low,
              timeBetweenPlaceAndFill: calculateTimeDiffInMinutes(activeStopLossOrder.placedTime, candle.timestamp_readable_IST),
              placedAtCandleIndex: activeStopLossOrder.placedAtCandle,
              filledAtCandleIndex: i
            };

            break;
          } else if (stopLossConfig.dynamicStopLossAdjustment) {
            // Price didn't recover, update limit order to current rounded close if worse
            const oldPrice = activeStopLossOrder.price;
            const newPrice = applyPriceRounding(candle.close, config);

            // Only update if price is worse (lower for long positions) and meaningful change
            if (newPrice < oldPrice && Math.abs(newPrice - oldPrice) >= 0.05) {
              const priceUpdate = {
                candleIndex: i,
                time: formatTimestamp(candle.timestamp_readable_IST),
                oldPrice: oldPrice,
                newPrice: newPrice,
                candleHigh: candle.high,
                candleLow: candle.low,
                candleClose: candle.close,
                reason: "dynamic_stop_loss_adjustment"
              };

              activeStopLossOrder.price = newPrice;
              activeStopLossOrder.priceUpdates.push(priceUpdate);
              stopLossExitDetails.totalPriceUpdates++;
              stopLossExitDetails.limitOrderHistory.push({
                action: "updated",
                price: newPrice,
                time: formatTimestamp(candle.timestamp_readable_IST),
                candleIndex: i,
                reason: "dynamic_adjustment"
              });
            }
          }
        }

        // Circuit breaker: Force market exit if loss exceeds maximum threshold
        if (stopLossConfig.forceMarketOrderAfterMax && stopLossConfig.maxLossPercent) {
          const currentLoss = trade.entry.price - candle.low;
          const lossPercentage = (currentLoss / riskPoints) * 100;

          if (lossPercentage >= stopLossConfig.maxLossPercent) {
            exitPrice = applyPriceRounding(candle.low, config);
            exitTime = formatTimestamp(candle.timestamp_readable_IST);
            exitReason = `circuit breaker (${stopLossConfig.maxLossPercent}% max loss)`;
            stopLossExitDetails.finalExitPrice = exitPrice;
            stopLossExitDetails.finalExitReason = exitReason;
            stopLossExitDetails.circuitBreakerTriggered = true;
            targetExitDetails.finalExitPrice = exitPrice;
            targetExitDetails.finalExitReason = exitReason;
            break;
          }
        }
      }

    } else { // Short position
      currentPnL = (trade.entry.price - candle.low) * maxShares;
      maxFavorableExcursion = Math.max(maxFavorableExcursion, currentPnL);

      // NEW: Check if target was hit with skip-one-candle limit order logic
      if (targetConfig.enabled && !targetHit && !activeTargetOrder && candle.low <= trade.target) {
        targetHit = true;
        targetExitDetails.targetHit = true;
        targetExitDetails.hitCandleTime = formatTimestamp(candle.timestamp_readable_IST);
        targetExitDetails.hitCandleClose = candle.close;
        targetExitDetails.hitCandleIndex = i;

        // Place limit buy order at rounded closing price
        const roundedClosePrice = applyPriceRounding(candle.close, config);
        activeTargetOrder = {
          price: roundedClosePrice,
          originalPrice: roundedClosePrice,
          placedTime: formatTimestamp(candle.timestamp_readable_IST),
          placedAtCandle: i,
          priceUpdates: []
        };

        targetExitDetails.originalLimitPrice = roundedClosePrice;
        targetExitDetails.limitOrderHistory.push({
          action: "placed",
          price: roundedClosePrice,
          time: formatTimestamp(candle.timestamp_readable_IST),
          candleIndex: i,
          reason: "target_hit"
        });
      }

      // Check if target limit order should be filled or updated (skip one candle)
      if (activeTargetOrder && i > activeTargetOrder.placedAtCandle + 1) {
        // Check if price moved below our limit order
        if (candle.low <= activeTargetOrder.price) {
          exitPrice = activeTargetOrder.price;
          exitTime = formatTimestamp(candle.timestamp_readable_IST);
          exitReason = "target limit order filled";
          stopLossExitDetails.finalExitPrice = exitPrice;
          stopLossExitDetails.finalExitReason = exitReason;
          targetExitDetails.finalExitPrice = exitPrice;
          targetExitDetails.finalExitReason = exitReason;
          targetExitDetails.finalLimitPrice = activeTargetOrder.price;

          targetExitDetails.orderFillDetails = {
            filledOrderPrice: activeTargetOrder.price,
            fillTime: formatTimestamp(candle.timestamp_readable_IST),
            fillCandleHigh: candle.high,
            fillCandleLow: candle.low,
            timeBetweenPlaceAndFill: calculateTimeDiffInMinutes(activeTargetOrder.placedTime, candle.timestamp_readable_IST),
            placedAtCandleIndex: activeTargetOrder.placedAtCandle,
            filledAtCandleIndex: i
          };

          break;
        } else if (targetExitDetails.dynamicTargetAdjustment) {
          // Price didn't reach target order, update limit order to current rounded close if better
          const oldPrice = activeTargetOrder.price;
          const newPrice = applyPriceRounding(candle.close, config);

          // Only update if price is better (lower for short positions) and meaningful change
          if (newPrice < oldPrice && Math.abs(newPrice - oldPrice) >= 0.05) {
            const priceUpdate = {
              candleIndex: i,
              time: formatTimestamp(candle.timestamp_readable_IST),
              oldPrice: oldPrice,
              newPrice: newPrice,
              candleHigh: candle.high,
              candleLow: candle.low,
              candleClose: candle.close,
              reason: "dynamic_target_adjustment"
            };

            activeTargetOrder.price = newPrice;
            activeTargetOrder.priceUpdates.push(priceUpdate);
            targetExitDetails.totalPriceUpdates++;
            targetExitDetails.limitOrderHistory.push({
              action: "updated",
              price: newPrice,
              time: formatTimestamp(candle.timestamp_readable_IST),
              candleIndex: i,
              reason: "dynamic_adjustment"
            });
          }
        }
      }

      // Stop loss logic with skip-one-candle logic for short positions
      if (stopLossConfig.enabled && !activeTargetOrder) { // Only check stop loss if target order not active
        // First, check if stop loss has been breached
        if (!stopLossBreach && candle.high >= trade.stopLoss) {
          stopLossBreach = true;
          stopLossExitDetails.stopLossBreached = true;
          stopLossExitDetails.breachCandleTime = formatTimestamp(candle.timestamp_readable_IST);
          stopLossExitDetails.breachCandleClose = candle.close;
          stopLossExitDetails.breachCandleIndex = i;

          // Place limit order at rounded closing price
          const roundedClosePrice = applyPriceRounding(candle.close, config);
          activeStopLossOrder = {
            price: roundedClosePrice,
            originalPrice: roundedClosePrice,
            placedTime: formatTimestamp(candle.timestamp_readable_IST),
            placedAtCandle: i,
            priceUpdates: []
          };

          stopLossExitDetails.originalLimitPrice = roundedClosePrice;
          stopLossExitDetails.limitOrderHistory.push({
            action: "placed",
            price: roundedClosePrice,
            time: formatTimestamp(candle.timestamp_readable_IST),
            candleIndex: i,
            reason: "stop_loss_breach"
          });
        }

        // If we have an active stop loss order, check if it should be filled or updated (skip one candle)
        if (activeStopLossOrder && i > activeStopLossOrder.placedAtCandle + 1) {
          // Check if price moved below our limit order (recovery)
          if (candle.low <= activeStopLossOrder.price) {
            exitPrice = activeStopLossOrder.price;
            exitTime = formatTimestamp(candle.timestamp_readable_IST);
            exitReason = "stop loss limit order filled";
            stopLossExitDetails.finalExitPrice = exitPrice;
            stopLossExitDetails.finalExitReason = exitReason;
            stopLossExitDetails.finalLimitPrice = activeStopLossOrder.price;
            targetExitDetails.finalExitPrice = exitPrice;
            targetExitDetails.finalExitReason = exitReason;

            stopLossExitDetails.orderFillDetails = {
              filledOrderPrice: activeStopLossOrder.price,
              fillTime: formatTimestamp(candle.timestamp_readable_IST),
              fillCandleHigh: candle.high,
              fillCandleLow: candle.low,
              timeBetweenPlaceAndFill: calculateTimeDiffInMinutes(activeStopLossOrder.placedTime, candle.timestamp_readable_IST),
              placedAtCandleIndex: activeStopLossOrder.placedAtCandle,
              filledAtCandleIndex: i
            };

            break;
          } else if (stopLossConfig.dynamicStopLossAdjustment) {
            // Price didn't recover, update limit order to current rounded close if worse
            const oldPrice = activeStopLossOrder.price;
            const newPrice = applyPriceRounding(candle.close, config);

            // Only update if price is worse (higher for short positions) and meaningful change
            if (newPrice > oldPrice && Math.abs(newPrice - oldPrice) >= 0.05) {
              const priceUpdate = {
                candleIndex: i,
                time: formatTimestamp(candle.timestamp_readable_IST),
                oldPrice: oldPrice,
                newPrice: newPrice,
                candleHigh: candle.high,
                candleLow: candle.low,
                candleClose: candle.close,
                reason: "dynamic_stop_loss_adjustment"
              };

              activeStopLossOrder.price = newPrice;
              activeStopLossOrder.priceUpdates.push(priceUpdate);
              stopLossExitDetails.totalPriceUpdates++;
              stopLossExitDetails.limitOrderHistory.push({
                action: "updated",
                price: newPrice,
                time: formatTimestamp(candle.timestamp_readable_IST),
                candleIndex: i,
                reason: "dynamic_adjustment"
              });
            }
          }
        }

        // Circuit breaker: Force market exit if loss exceeds maximum threshold
        if (stopLossConfig.forceMarketOrderAfterMax && stopLossConfig.maxLossPercent) {
          const currentLoss = candle.high - trade.entry.price;
          const lossPercentage = (currentLoss / riskPoints) * 100;

          if (lossPercentage >= stopLossConfig.maxLossPercent) {
            exitPrice = applyPriceRounding(candle.high, config);
            exitTime = formatTimestamp(candle.timestamp_readable_IST);
            exitReason = `circuit breaker (${stopLossConfig.maxLossPercent}% max loss)`;
            stopLossExitDetails.finalExitPrice = exitPrice;
            stopLossExitDetails.finalExitReason = exitReason;
            stopLossExitDetails.circuitBreakerTriggered = true;
            targetExitDetails.finalExitPrice = exitPrice;
            targetExitDetails.finalExitReason = exitReason;
            break;
          }
        }
      }
    }
  }

  // If we didn't exit during the day, use market close price with rounding
  if (!exitPrice) {
    const lastCandle = dayData[dayData.length - 1];
    exitPrice = applyPriceRounding(lastCandle.close, config);
    exitTime = formatTimestamp(lastCandle.timestamp_readable_IST);
    exitReason = "market close";
    stopLossExitDetails.finalExitPrice = exitPrice;
    stopLossExitDetails.finalExitReason = exitReason;
    targetExitDetails.finalExitPrice = exitPrice;
    targetExitDetails.finalExitReason = exitReason;
  }

  // Finalize order details
  if (activeStopLossOrder) {
    stopLossExitDetails.finalLimitPrice = activeStopLossOrder.price;
  }
  if (activeTargetOrder) {
    targetExitDetails.finalLimitPrice = activeTargetOrder.price;
  }

  // Calculate exit value and brokerage fee
  const exitValue = maxShares * exitPrice;
  const exitBrokerageFee = (exitValue * brokerageFeePercent) / 100;

  // Calculate profit without brokerage fees (gross profit)
  const grossProfit = trade.type === "long" ?
    (exitPrice - trade.entry.price) * maxShares :
    (trade.entry.price - exitPrice) * maxShares;

  // Calculate final profit/loss with shares and brokerage fees (net profit)
  const netProfit = grossProfit - (entryBrokerageFee + exitBrokerageFee);

  // Calculate profit percentage (based on actual capital used, not leveraged amount)
  const actualCapitalUsed = investedAmount / (capital.leverage || 1);
  const netProfitPercentage = (netProfit / actualCapitalUsed) * 100;
  const grossProfitPercentage = (grossProfit / actualCapitalUsed) * 100;

  // Create the trade result object
  return {
    date,
    type: trade.type,
    entry: {
      price: trade.entry.price,
      time: trade.entry.time,
      fee: entryBrokerageFee
    },
    exit: {
      price: exitPrice,
      time: exitTime,
      reason: exitReason,
      fee: exitBrokerageFee
    },
    target: trade.target,
    stopLoss: trade.stopLoss,
    shares: maxShares,
    leverage: capital.leverage || 1,
    grossInvestedAmount: investedAmount,
    actualCapitalUsed: actualCapitalUsed,
    totalFees: entryBrokerageFee + exitBrokerageFee,
    riskPoints: riskPoints,
    profit: netProfit,
    profitPercentage: netProfitPercentage,
    grossProfit: grossProfit,
    netProfit: netProfit,
    grossProfitPercentage: grossProfitPercentage,
    netProfitPercentage: netProfitPercentage,
    patterns: trade.patterns,
    maxFavorableExcursion: maxFavorableExcursion,
    volumeInfo: trade.volumeInfo,
    breakout: trade.breakoutDetails,
    stopLossExitDetails: stopLossExitDetails, // Enhanced with skip-one-candle logic
    targetExitDetails: targetExitDetails, // NEW: Target exit details with skip-one-candle logic
    preMarketExitDetails: preMarketExitDetails // Enhanced with skip-one-candle logic
  };
}

/**
 * Backtest the strategy on the given data
 * @param {Object} stockData - The stock data object
 * @param {Object} config - Configuration object
 * @returns {Object} - The backtest results
 */
function backtest(stockData, config = defaultConfig) {
  // Merge with default config
  config = { ...defaultConfig, ...config };

  // Extract dates from the data
  const dates = Object.keys(stockData.data).filter(date => shouldIncludeDate(date, config));

  // Array to store all trades
  const allTrades = [];

  // Process each trading day
  for (const date of dates) {
    const dayData = stockData.data[date];
    const dayTradeResult = analyzeTradingDay(date, dayData, config);
    allTrades.push(dayTradeResult);
  }

  // Calculate statistics
  const stats = calculateStats(allTrades, config.capital, config);

  return {
    ...stats,
    allTrades,
    configUsed: config
  };
}

/**
 * Calculate statistics for the backtest results
 * @param {Array} trades - Array of trade objects
 * @param {Object} capital - Capital configuration
 * @param {Object} config - Full configuration object
 * @returns {Object} - Statistics object
 */
function calculateStats(trades, capital, config) {
  // Filter actual trades (those with profit field)
  const actualTrades = trades.filter(trade => trade.profit !== undefined || trade.netProfit !== undefined);

  // Calculate total gross profit (without brokerage fees)
  const totalGrossProfit = actualTrades.reduce((sum, trade) => sum + (trade.grossProfit || trade.profit || 0), 0);

  // Calculate total net profit (with brokerage fees)
  const totalNetProfit = actualTrades.reduce((sum, trade) => sum + (trade.netProfit || trade.profit || 0), 0);

  // For backward compatibility
  const totalProfit = totalNetProfit;

  // Calculate average profit per trade
  const averageGrossProfitPerTrade = actualTrades.length > 0 ? totalGrossProfit / actualTrades.length : 0;
  const averageNetProfitPerTrade = actualTrades.length > 0 ? totalNetProfit / actualTrades.length : 0;
  const averageProfitPerTrade = averageNetProfitPerTrade;

  // Calculate total fees
  const totalFees = actualTrades.reduce((sum, trade) => sum + (trade.totalFees || 0), 0);

  // Calculate the total return percentage
  const totalGrossReturnPercentage = (totalGrossProfit / capital.initial) * 100;
  const totalNetReturnPercentage = (totalNetProfit / capital.initial) * 100;
  const totalReturnPercentage = totalNetReturnPercentage;

  // Calculate average profit percentage per trade
  const averageGrossProfitPercentagePerTrade = actualTrades.length > 0 ?
    actualTrades.reduce((sum, trade) => sum + (trade.grossProfitPercentage || trade.profitPercentage || 0), 0) / actualTrades.length : 0;
  const averageNetProfitPercentagePerTrade = actualTrades.length > 0 ?
    actualTrades.reduce((sum, trade) => sum + (trade.netProfitPercentage || trade.profitPercentage || 0), 0) / actualTrades.length : 0;
  const averageProfitPercentagePerTrade = averageNetProfitPercentagePerTrade;

  // Calculate final balance
  const finalBalance = capital.initial + totalNetProfit;

  // Count winning and losing days
  const winningDays = actualTrades.filter(trade => (trade.netProfit || trade.profit || 0) > 0);
  const losingDays = actualTrades.filter(trade => (trade.netProfit || trade.profit || 0) <= 0);

  // Count positive and negative days
  const positiveDays = winningDays.length;
  const negativeDays = losingDays.length;

  // Group by exit reason
  const exitReasons = {};
  for (const trade of actualTrades) {
    const reason = trade.exit.reason;
    if (!exitReasons[reason]) {
      exitReasons[reason] = {
        count: 0,
        totalProfit: 0,
        averageProfit: 0
      };
    }
    exitReasons[reason].count++;
    exitReasons[reason].totalProfit += (trade.netProfit || trade.profit || 0);
  }

  // Calculate average profit by exit reason
  for (const reason in exitReasons) {
    exitReasons[reason].averageProfit = exitReasons[reason].totalProfit / exitReasons[reason].count;
  }

  // Enhanced stop loss exit analysis with skip-one-candle logic
  let stopLossExitAnalysis = null;
  if (config.stopLossExitConfig?.enabled) {
    const stopLossLimitOrderExits = actualTrades.filter(trade =>
      trade.exit.reason === 'stop loss limit order filled'
    );

    const circuitBreakerExits = actualTrades.filter(trade =>
      trade.stopLossExitDetails?.circuitBreakerTriggered === true
    );

    const tradesWithStopLossBreach = actualTrades.filter(trade =>
      trade.stopLossExitDetails?.stopLossBreached === true
    );

    const tradesWithDynamicStopLossAdjustment = actualTrades.filter(trade =>
      trade.stopLossExitDetails?.totalPriceUpdates > 0
    );

    const averageStopLossPriceUpdates = tradesWithDynamicStopLossAdjustment.length > 0 ?
      tradesWithDynamicStopLossAdjustment.reduce((sum, trade) => sum + trade.stopLossExitDetails.totalPriceUpdates, 0) / tradesWithDynamicStopLossAdjustment.length : 0;

    stopLossExitAnalysis = {
      enabled: true,
      skipOneCandleLogic: true,
      dynamicStopLossAdjustment: config.stopLossExitConfig.dynamicStopLossAdjustment || false,
      totalDynamicStopLossExits: stopLossLimitOrderExits.length,
      totalTraditionalStopLossExits: 0, // No traditional SL exits in new system
      totalCircuitBreakerExits: circuitBreakerExits.length,
      totalTradesWithStopLossBreach: tradesWithStopLossBreach.length,
      totalTradesWithDynamicAdjustment: tradesWithDynamicStopLossAdjustment.length,
      averageProfitDynamicStopLossExits: stopLossLimitOrderExits.length > 0 ?
        stopLossLimitOrderExits.reduce((sum, trade) => sum + (trade.netProfit || 0), 0) / stopLossLimitOrderExits.length : 0,
      averageProfitTraditionalExits: 0, // No traditional exits in new system
      averageProfitCircuitBreakerExits: circuitBreakerExits.length > 0 ?
        circuitBreakerExits.reduce((sum, trade) => sum + (trade.netProfit || 0), 0) / circuitBreakerExits.length : 0,
      averageStopLossPriceUpdates: averageStopLossPriceUpdates,
      config: config.stopLossExitConfig
    };
  }

  // NEW: Target exit analysis with skip-one-candle logic
  let targetExitAnalysis = null;
  if (config.targetExitConfig?.enabled) {
    const targetLimitOrderExits = actualTrades.filter(trade =>
      trade.exit.reason === 'target limit order filled'
    );

    const tradesWithTargetHit = actualTrades.filter(trade =>
      trade.targetExitDetails?.targetHit === true
    );

    const tradesWithDynamicTargetAdjustment = actualTrades.filter(trade =>
      trade.targetExitDetails?.totalPriceUpdates > 0
    );

    const averageTargetPriceUpdates = tradesWithDynamicTargetAdjustment.length > 0 ?
      tradesWithDynamicTargetAdjustment.reduce((sum, trade) => sum + trade.targetExitDetails.totalPriceUpdates, 0) / tradesWithDynamicTargetAdjustment.length : 0;

    targetExitAnalysis = {
      enabled: true,
      skipOneCandleLogic: true,
      dynamicTargetAdjustment: config.targetExitConfig.dynamicTargetAdjustment || false,
      totalTargetLimitOrderExits: targetLimitOrderExits.length,
      totalTradesWithTargetHit: tradesWithTargetHit.length,
      totalTradesWithDynamicAdjustment: tradesWithDynamicTargetAdjustment.length,
      targetLimitOrderFillRate: tradesWithTargetHit.length > 0 ?
        (targetLimitOrderExits.length / tradesWithTargetHit.length) * 100 : 0,
      averageProfitTargetLimitOrderExits: targetLimitOrderExits.length > 0 ?
        targetLimitOrderExits.reduce((sum, trade) => sum + (trade.netProfit || 0), 0) / targetLimitOrderExits.length : 0,
      averageTargetPriceUpdates: averageTargetPriceUpdates,
      config: config.targetExitConfig
    };
  }

  // Enhanced pre-market exit analysis with skip-one-candle logic
  let preMarketExitAnalysis = null;
  if (config.marketExitTime?.enabled) {
    const preMarketExits = actualTrades.filter(trade =>
      trade.exit.reason === 'pre-market exit limit order filled'
    );

    const forcedMarketExits = actualTrades.filter(trade =>
      trade.exit.reason === 'forced market exit'
    );

    const tradesWithPreMarketOrders = actualTrades.filter(trade =>
      trade.preMarketExitDetails?.orderPlaced
    );

    const tradesWithDynamicPricing = actualTrades.filter(trade =>
      trade.preMarketExitDetails?.dynamicPriceAdjustment && trade.preMarketExitDetails?.totalPriceUpdates > 0
    );

    const averagePriceUpdatesPerTrade = tradesWithDynamicPricing.length > 0 ?
      tradesWithDynamicPricing.reduce((sum, trade) => sum + trade.preMarketExitDetails.totalPriceUpdates, 0) / tradesWithDynamicPricing.length : 0;

    const averagePriceImprovement = tradesWithPreMarketOrders.length > 0 ?
      tradesWithPreMarketOrders.reduce((sum, trade) => sum + (trade.preMarketExitDetails.priceImprovement || 0), 0) / tradesWithPreMarketOrders.length : 0;

    const averagePriceImprovementVsForcedExit = tradesWithPreMarketOrders.length > 0 ?
      tradesWithPreMarketOrders.reduce((sum, trade) => sum + (trade.preMarketExitDetails.priceImprovementVsForcedExit || 0), 0) / tradesWithPreMarketOrders.length : 0;

    preMarketExitAnalysis = {
      enabled: true,
      skipOneCandleLogic: true,
      dynamicPriceAdjustment: config.marketExitTime?.dynamicPriceAdjustment || false,
      totalPreMarketExits: preMarketExits.length,
      totalForcedMarketExits: forcedMarketExits.length,
      totalTradesWithPreMarketOrders: tradesWithPreMarketOrders.length,
      totalTradesWithDynamicPricing: tradesWithDynamicPricing.length,
      preMarketOrderFillRate: tradesWithPreMarketOrders.length > 0 ?
        (preMarketExits.length / tradesWithPreMarketOrders.length) * 100 : 0,
      averageProfitPreMarketExits: preMarketExits.length > 0 ?
        preMarketExits.reduce((sum, trade) => sum + (trade.netProfit || 0), 0) / preMarketExits.length : 0,
      averageProfitForcedExits: forcedMarketExits.length > 0 ?
        forcedMarketExits.reduce((sum, trade) => sum + (trade.netProfit || 0), 0) / forcedMarketExits.length : 0,
      preExitLimitOrderMinutes: config.marketExitTime.preExitLimitOrderMinutes || 10,
      averagePriceUpdatesPerTrade: averagePriceUpdatesPerTrade,
      averagePriceImprovement: averagePriceImprovement,
      averagePriceImprovementVsForcedExit: averagePriceImprovementVsForcedExit,
      dynamicPricingFillRate: tradesWithDynamicPricing.length > 0 ?
        (tradesWithDynamicPricing.filter(trade => trade.preMarketExitDetails.orderFilled).length / tradesWithDynamicPricing.length) * 100 : 0
    };
  }

  // Calculate risk-reward metrics
  let actualAverageRR = 0;
  let plannedRR = 0;

  if (actualTrades.length > 0) {
    actualAverageRR = actualTrades.reduce((sum, trade) => {
      return sum + ((trade.netProfit || trade.profit || 0) / (trade.riskPoints * trade.shares));
    }, 0) / actualTrades.length;

    plannedRR = config.riskRewardRatio || 1;
  }

  // Calculate win rate
  const winRate = actualTrades.length > 0 ? positiveDays / actualTrades.length * 100 : 0;

  // NEW: Entry order analysis with skip-one-candle logic
  let entryOrderAnalysis = null;
  const tradesWithEntryOrders = actualTrades.filter(trade =>
    trade.breakout?.entryOrderDetails
  );

  if (tradesWithEntryOrders.length > 0) {
    const tradesWithEntryPriceUpdates = tradesWithEntryOrders.filter(trade =>
      trade.breakout.entryOrderDetails.priceUpdates.length > 0
    );

    const averageEntryPriceUpdates = tradesWithEntryPriceUpdates.length > 0 ?
      tradesWithEntryPriceUpdates.reduce((sum, trade) => sum + trade.breakout.entryOrderDetails.priceUpdates.length, 0) / tradesWithEntryPriceUpdates.length : 0;

    const averageEntryPriceImprovement = tradesWithEntryOrders.length > 0 ?
      tradesWithEntryOrders.reduce((sum, trade) => {
        const improvement = trade.type === "long" ?
          trade.breakout.entryOrderDetails.originalOrderPrice - trade.breakout.entryOrderDetails.finalOrderPrice :
          trade.breakout.entryOrderDetails.finalOrderPrice - trade.breakout.entryOrderDetails.originalOrderPrice;
        return sum + improvement;
      }, 0) / tradesWithEntryOrders.length : 0;

    entryOrderAnalysis = {
      enabled: true,
      skipOneCandleLogic: true,
      dynamicEntryAdjustment: config.entryOrderConfig?.dynamicEntryAdjustment || false,
      totalTradesWithEntryOrders: tradesWithEntryOrders.length,
      totalTradesWithEntryPriceUpdates: tradesWithEntryPriceUpdates.length,
      entryOrderFillRate: actualTrades.length > 0 ?
        (tradesWithEntryOrders.length / actualTrades.length) * 100 : 0,
      averageEntryPriceUpdates: averageEntryPriceUpdates,
      averageEntryPriceImprovement: averageEntryPriceImprovement,
      dynamicEntryPricingFillRate: tradesWithEntryPriceUpdates.length > 0 ?
        (tradesWithEntryPriceUpdates.length / tradesWithEntryOrders.length) * 100 : 0,
      config: config.entryOrderConfig
    };
  }

  // Count entry orders that didn't result in trades
  const entryOrdersWithoutTrade = trades.filter(trade => trade.entryOrderPlaced).length;

  // Count breakouts that didn't result in trades (including entry orders that didn't fill)
  const breakoutsWithoutEntry = trades.filter(trade => trade.breakoutDetected && !trade.profit && !trade.netProfit).length;

  // Count breakouts outside time range
  const breakoutsOutsideTimeRange = trades.filter(trade => trade.breakoutOutsideTimeRange).length;

  // NEW: Count breakouts rejected due to minimum stop loss percentage
  const minimumStopLossRejections = trades.filter(trade => trade.minimumStopLossRejection).length;

  return {
    initialCapital: capital.initial,
    leverage: capital.leverage || 1,
    brokerageFeePercent: capital.brokerageFeePercent || 0,
    finalBalance,
    totalProfit,
    totalGrossProfit,
    totalNetProfit,
    totalFees,
    totalReturnPercentage,
    totalGrossReturnPercentage,
    totalNetReturnPercentage,
    averageProfitPerTrade,
    averageGrossProfitPerTrade,
    averageNetProfitPerTrade,
    averageProfitPercentagePerTrade,
    averageGrossProfitPercentagePerTrade,
    averageNetProfitPercentagePerTrade,
    totalWinningDays: positiveDays,
    totalLosingDays: negativeDays,
    winningDays,
    losingDays,
    positiveDays,
    negativeDays,
    statisticsByExitReason: exitReasons,
    riskRewardAnalysis: {
      actualAverageRR,
      plannedRR,
      winRate: winRate / 100
    },
    winRate,
    breakoutsWithoutEntry,
    breakoutsOutsideTimeRange,
    minimumStopLossRejections, // NEW: Track rejections due to tight stop loss
    stopLossExitAnalysis, // Enhanced with skip-one-candle logic
    targetExitAnalysis, // NEW: Target exit analysis with skip-one-candle logic  
    preMarketExitAnalysis, // Enhanced with skip-one-candle logic
    entryOrderAnalysis, // NEW: Entry order analysis with skip-one-candle logic
    priceRoundingConfig: config.priceRounding, // Include price rounding configuration in results
    minimumStopLossConfig: {
      enabled: config.minimumStopLossPercent > 0,
      minimumStopLossPercent: config.minimumStopLossPercent,
      totalRejections: minimumStopLossRejections
    } // NEW: Include minimum stop loss configuration and stats
  };
}

/**
 * Main function to run the backtest
 * @param {string} filePath - Path to the JSON file
 * @param {Object} config - Configuration object
 * @returns {Object} - The backtest results
 */
function runBacktest(filePath, config = defaultConfig) {
  try {
    // Read the stock data
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const stockData = JSON.parse(fileContent);

    // Run the backtest
    return backtest(stockData, config);
  } catch (error) {
    console.error('Error running backtest:', error);
    return { error: error.message };
  }
}

// Export the functions
module.exports = {
  runBacktest,
  backtest,
  analyzeTradingDay,
  simulateTrade,
  calculateStats,
  defaultConfig,
  roundToTickSize,
  applyPriceRounding,
  isMinimumStopLossPercentMet
};