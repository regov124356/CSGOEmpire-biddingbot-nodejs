// @ts-check
import { io } from 'socket.io-client';
import axios from 'axios';
import { logger } from './logger.js';
import { connectToDatabase, sql } from './connectToDatabase.js';
import { Mutex } from 'async-mutex';
import 'dotenv/config';

const csgoempireApiKey = process.env.CSGOEMPIRE_API_KEY;
const csgoempireUrl = process.env.CSGOEMPIRE_URL;
const csgoempireWebSocketUrl = process.env.CSGOEMPIRE_WEBSOCKET_URL;

console.log(csgoempireWebSocketUrl, csgoempireUrl, csgoempireApiKey);

axios.defaults.headers.common['Authorization'] = `Bearer ${csgoempireApiKey}`;
axios.defaults.headers.post['Content-Type'] = 'application/json';
axios.defaults.headers.get['Accept'] = 'application/json';

const mutex = new Mutex();

let activeAuctions = [];

const query = 'SELECT price_empire FROM item_prices JOIN items ON item_prices.item_id = items.id WHERE market_hash_name = @itemName';

async function placeBid(item, bidValue, bidMax) {
    try {
        const response = await axios.post(`${csgoempireUrl}/api/v2/trading/deposit/${item.id}/bid`, {}, {
            params: { bid_value: bidValue },
        });
        const responseData = response.data;

        logger.info(`Bid request sent: ${responseData.success}`);

        if (responseData?.success) {
            return 1;
        } else {
            const message = responseData.message ?? null;
            logger.info(`Error placing bid: ${message}`);

            const error_key = responseData.data?.error_key ?? null;

            if (error_key == "bid_already_placed") {
                const nextBidValue = responseData.data.next_bid;

                if (nextBidValue <= bidMax) {
                    return await placeBid(item, nextBidValue, bidMax);
                }
            } else if (message == "You can only make one trade at a time. Please wait a moment and try again.") {
                await new Promise(resolve => setTimeout(resolve, 1000));
                return await placeBid(item, bidValue, bidMax);

            } else if (error_key == "auction_already_finished" || message == "You are temporarily restricted from withdrawing or placing bids." || message == "You don't have enough balance to do that!") {
                //smth
            } else if (message == "You don't have enough balance to do that!") {
                return 2;
            } else {
                logger.info(`Unhandled error: ${message}`);
            }
            return 0;
        }
    } catch (error) {
        logger.error('Error in placeBid:', {
            status: error.response.status,
            data: error.response.data
        });
        return 0;
    }
}



async function findItemIdInActiveAuctions(itemId) {
    let existsItemId;
    const release = await mutex.acquire();
    try {
        existsItemId = activeAuctions.find(arr => arr.id === itemId) || null;
    } finally {
        release();
    }
    return existsItemId;
}

async function getActiveAuctions() {
    try {
        const response = await axios.get(`${csgoempireUrl}/api/v2/trading/user/auctions`);

        const responseData = response.data;

        const release = await mutex.acquire();
        try {
            activeAuctions = [];
            if (responseData.active_auctions && responseData.active_auctions.length > 0) {
                responseData.active_auctions.forEach(a => {
                    activeAuctions.push([a.id, a.marketName]);
                });
            } else {
                logger.info("No active auctions found.");
            }
        } finally {
            release();
        }
    } catch (error) {
        logger.error('Error in getActiveAuctions:', {
            status: error.response.status,
            data: error.response.data
        });
    }
}


async function getUserData() {

    try {
        const response = await axios.get(`${csgoempireUrl}/api/v2/metadata/socket`);
        const userData = response.data;

        if (userData && userData.user) {
            return userData;
        } else {
            logger.info("Received userData is empty");
        }

    } catch (error) {
        logger.error('Error in getUserData:', {
            status: error.response.status,
            data: error.response.data
        });
    }
}


async function updateFilters(socket, userData) {
    try {
        if (userData.user.balance < 30) {
            logger.info(`The balance is too small (${userData.user.balance / 100} coins)`);
        } else {
            socket.emit('filters', {
                price_max: userData.user.balance,
                per_page: 2500,
                auction: 'yes',
                price_max_above: 20,
            });
            logger.info(`The current balance is: ${userData.user.balance}`);
        }
    } catch (error) {
        logger.error('Error in updateFilters:', {
            status: error.response.status,
            data: error.response.data
        });
    }
}


function reconnectToServer() {
    logger.info('Reconnecting to server...');
    setTimeout(() => { initSocket() }, 5000);
}


async function initSocket() {
    logger.info("Connecting to websocket...");
    await connectToDatabase();

    try {
        const userData = await getUserData();

        const options = {
            transports: ["websocket"],
            path: "/s/",
            secure: true,
            rejectUnauthorized: false,
            extraHeaders: { 'User-agent': `${userData.user.id} API Bot` }
        }

        const socket = io(csgoempireWebSocketUrl, options);

        socket.on('connect', async () => {
            logger.info(`Connected to websocket`);

            socket.on('init', (data) => {
                if (data && data.authenticated) {
                    logger.info(`Successfully authenticated as ${data.name}`);
                    updateFilters(socket, userData);
                } else {
                    socket.emit('identify', {
                        uid: userData.user.id,
                        model: userData.user,
                        authorizationToken: userData.socket_token,
                        signature: userData.socket_signature
                    });
                    logger.info(`Successfully identify`);
                }
            });

            socket.on('timesync', (data) => logger.info(`Timesync: ${JSON.stringify(data)}`));


            socket.on('new_item', async (items) => {
                await Promise.all(items.map(async (item) => {
                    const request = new sql.Request();
                    const result = await request
                        .input('itemName', sql.VarChar, item.market_name)
                        .query(query);

                    if (result.recordset && result.recordset.length > 0) {
                        const priceRecord = result.recordset[0];
                        if (priceRecord.price_empire !== undefined) {
                            const price = priceRecord.price_empire;
                            let bidMax = price;

                            if (bidMax >= item.market_value) {
                                logger.info(`deposit_id: ${item.id}`);
                                logger.info(`market_name: ${item.market_name}`);
                                logger.info(`market_value: ${item.market_value / 100}`);

                                const result = await placeBid(item, item.market_value, bidMax);
                                if (result == 1) {
                                    getActiveAuctions();
                                } else if (result == 2) {
                                    const userData = await getUserData();
                                    updateFilters(socket, userData);
                                }
                            }
                        }
                    }
                }));
            });

            socket.on('auction_update', async (items) => {
                await Promise.all(items.map(async (item) => {
                    const existsInActiveAuctions = await findItemIdInActiveAuctions(item.id);

                    if (existsInActiveAuctions && (item.auction_highest_bidder !== 10094491)) {
                        const request = new sql.Request();
                        const result = await request
                            .input('itemName', sql.VarChar, existsInActiveAuctions[1])
                            .query(query);

                        if (result.recordset && result.recordset.length > 0) {
                            const priceRecord = result.recordset[0];
                            if (priceRecord.price_empire !== undefined) {
                                const price = priceRecord.price_empire;
                                let bidMax = price;

                                let bid = parseFloat((item.auction_highest_bid * 1.01).toFixed(0));
                                if (bid == item.auction_highest_bid) {
                                    bid = Math.ceil(item.auction_highest_bid * 1.01);
                                }

                                if (bidMax >= bid) {
                                    logger.info(`Auction update: ${item.id}, bid: ${item.auction_highest_bid}, bidder: ${item.auction_highest_bidder}`);

                                    logger.info(`Placing a bid for ${item.id}`);
                                    const result = await placeBid(item, bid, 0);

                                    if (result == 2) {
                                        const userData = await getUserData();
                                        updateFilters(socket, userData);
                                    }
                                }
                            }
                        }
                    }
                }));
            });


            socket.on('trade_status', async (items) => {
                await Promise.all(items.map(async (item) => {
                    logger.info(`Trade status: ${item.data.status} for: ${item.data.item.market_name}. ID: ${item.data.id}`);
                    if (item.type == 'withdrawal') {
                        if (item.data.status == 5) {
                            logger.info(`Check if you received the item: ${item.data.item.market_name}, ${item.data.total_value / 100}C from ${item.data.metadata.partner.steam_name} (${item.data.metadata.partner.steam_level}). tradeId: ${item.data.id}, steamId: ${item.data.metadata.partner.steam_id}`);
                        }

                        if ([4, 8, 9, 10, 11].includes(item.data.status)) {
                            const userData = await getUserData();
                            updateFilters(socket, userData);
                        }
                    }
                }));
            });


            socket.on("disconnect", (reason) => {
                logger.info(`Socket disconnected: ${reason}`);
                if (['io client disconnect', 'transport close', 'ping timeout'].includes(reason)) {
                    reconnectToServer();
                    socket.close();
                }
            });
        });

        socket.on("close", (reason) => {
            logger.info(`Socket closed: ${reason}`);
        });

        socket.on('error', (data) => {
            logger.error(`WS Error: ${data}`);
        });

        socket.on('connect_error', (data) => {
            logger.error(`Connect Error: ${data}`);
        });

    } catch (error) {
        logger.error(`Error while initializing the Socket. Error: ${error}`);
        setTimeout(() => initSocket(), 180000)
    }
}

initSocket();