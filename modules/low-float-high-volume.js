// utils
const regCronIncAfterSixThirty = require('../utils/reg-cron-after-630');

// app-actions
const executeStrategy = require('../app-actions/execute-strategy');
const addTrendSinceOpen = require('../app-actions/add-trend-since-open');
// npm
const mapLimit = require('promise-map-limit');

// rh-actions
const getRisk = require('../rh-actions/get-risk');
const trendingUp = require('../rh-actions/trending-up');

const trendFilter = async (Robinhood, trend) => {
    // going up at least 3%

    console.log('running low-float-high-volume strategy');

    console.log('total trend stocks', trend.length);

    let withTrendSinceOpen = await addTrendSinceOpen(Robinhood, trend);
    withTrendSinceOpen = withTrendSinceOpen
        .filter(buy => buy.trendSinceOpen)
        .sort((a, b) => a.trendSinceOpen - b.trendSinceOpen);

    withTrendSinceOpen = withTrendSinceOpen
        .map(buy => {
            const { fundamentals } = buy;
            if (!fundamentals) return buy;
            const {
                shares_outstanding,
                market_cap,
                volume,
                average_volume,
                average_volume_2_weeks
            } = fundamentals;
            const sharesToCap = shares_outstanding / market_cap;    // "float"
            return {
                ...buy,
                sharesToCap,
                volumetoavg: volume / average_volume,
                volumeto2weekavg: volume / average_volume_2_weeks,
                twoweekvolumetoavg: average_volume_2_weeks / average_volume,
                absvolume: Number(volume),
                floatToVolume: sharesToCap / volume,
            };
        })
        .filter(buy => !!buy.sharesToCap);

    const addPoints = (ptKey, sort) => {
        return withTrendSinceOpen
            .sort(typeof sort === 'string' ? (a, b) => b[sort] - a[sort] : sort)
            .map((buy, index, array) => {
                const relPoints = (array.length - index) / array.length;
                return {
                    ...buy,
                    [ptKey]: relPoints,
                    ...(buy.floatPoints && {
                        [`floatTimes${ptKey}`]: buy.floatPoints * relPoints
                    })
                };
            });
    };

    withTrendSinceOpen = addPoints('floatPoints', (a, b) => a.sharesToCap - b.sharesToCap); // assumption: low float is better
    withTrendSinceOpen = addPoints('absVolPoints', 'absvolume');
    withTrendSinceOpen = addPoints('volToAvgPoints', 'volumetoavg');
    withTrendSinceOpen = addPoints('volTo2WeekPoints', 'volumeto2weekavg');
    withTrendSinceOpen = addPoints('twoWeekVolToAvgPoints', 'twoweekvolumetoavg');
    withTrendSinceOpen = addPoints('floatToVolume', 'floatToVolume');

    console.log('got trend since open')

    const baseKeys = Object.keys(withTrendSinceOpen[0])
        .filter(key => key.includes('floatTimes'));

    let returnObj = {};
    const riskCache = {};
    for (let key of baseKeys) {

        console.log('key', key);
        const sortTrend = (
            [
                min = Number.NEGATIVE_INFINITY,
                max = Number.POSITIVE_INFINITY
            ] = [undefined, undefined]
        ) => {
            return withTrendSinceOpen
                .filter(({ trendSinceOpen }) => {
                    return trendSinceOpen >= min && trendSinceOpen < max;
                })
                .sort((a, b) => b[key] - a[key]);
        };

        const processTrend = async (trendKey, limits) => {
            console.log('processing', trendKey);
            const sorted = sortTrend(limits);
            // console.log('sorted');
            // console.log(sorted[0]);
            const watchouts = {};
            for (let obj of sorted) {
                const { ticker } = obj;
                const risk = riskCache[ticker] ? riskCache[ticker] : await getRisk(Robinhood, ticker);
                riskCache[ticker] = risk;
                if (risk.shouldWatchout && !watchouts.should) {
                    watchouts.should = ticker;
                } else if (!risk.shouldWatchout && !watchouts.not) {
                    watchouts.not = ticker;
                }
                if (watchouts.should && watchouts.not) {
                    break;
                }
            };
            const base = `${key}${trendKey ? `-${trendKey}` : ''}`;
            return {
                ...sorted[0] && { [base]: sorted[0].ticker },
                ...watchouts.not && { [`${base}-notWatchout`]: watchouts.not },
                ...watchouts.should && { [`${base}-shouldWatchout`]: watchouts.should },
            };
        };

        const trendPerms = [
            [undefined, undefined], // unfiltered by trendsinceopen
            ['3to5', [3, 5]],
            ['5to10', [5, 10]],
            ['10to15', [10, 15]],
            ['15to25', [15, 25]],
            ['gt20', [20, undefined]],
            ['gt30', [30, undefined]],
            ['gt50', [50, undefined]],
            ['up1to3', [1, 3]],
            ['up0to1', [0, 1]],
            ['down1to3', [-3, -1]],
            ['down3to10', [-10, -3]],
            ['down3to5', [-5, -3]],
            ['down5to7', [-7, -5]],
            ['down7to10', [-10, -7]],
            ['downgt10', [undefined, -10]],
            ['downgt20', [undefined, -20]],
            ['downgt30', [undefined, -30]],
        ];
        for (let [trendKey, limits] of trendPerms) {
            returnObj = {
                ...returnObj,
                ...await processTrend(`trend${trendKey}`, limits)
            };
        }
        // console.log(returnObj, 'returnObj')
    }
    return returnObj;
};

const lowFloatHighVolume = {
    trendFilter,
    init: Robinhood => {
        // runs at init
        regCronIncAfterSixThirty(Robinhood, {
            name: 'execute low-float-high-volume strategy',
            run: [6, 25, 95, 150, 210, 276, 315, 384], // 10:41am, 11:31am
            // run: [],
            fn: async (Robinhood, min) => {
                await executeStrategy(Robinhood, trendFilter, min, 0.3, 'low-float-high-volume');
            }
        });
    }
};

module.exports = lowFloatHighVolume;
