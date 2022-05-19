"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios").default;
const Json2iob = require("./lib/json2iob");
const crypto = require("crypto");
const qs = require("qs");

// Load your modules here, e.g.:
// const fs = require("fs");

class Niu extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "niu",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
        this.deviceArray = [];
        this.json2iob = new Json2iob(this);
        this.requestClient = axios.create();
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);
        if (this.config.interval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.interval = 0.5;
        }
        if (!this.config.username || !this.config.password) {
            this.log.error("Please set username and password in the instance settings");
            return;
        }
        this.userAgent = "manager/4.7.16 (iPhone; iOS 14.8; Scale/3.00);deviceName=iPhone;timezone=Europe/Berlin;model=iPhone 8 Plus;lang=de-DE;ostype=iOS;clientIdentifier=Overseas";

        this.updateInterval = null;
        this.reLoginTimeout = null;
        this.refreshTokenTimeout = null;
        this.session = {};
        this.subscribeStates("*");

        await this.login();

        if (this.session.access_token) {
            await this.getDeviceList();
            await this.updateDevices();
            this.updateInterval = setInterval(async () => {
                await this.updateDevices();
            }, this.config.interval * 60 * 1000);
            this.refreshTokenInterval = setInterval(() => {
                this.refreshToken();
            }, 22 * 60 * 60 * 1000);
        }
    }
    async login() {
        await this.requestClient({
            method: "post",
            url: "https://account-fk.niu.com/v3/api/oauth2/token",
            headers: {
                accept: "*/*",
                token: "",
                "user-agent": "manager/4.7.12 (iPhone; iOS 14.8; Scale/3.00);deviceName=iPhone;timezone=Europe/Berlin;model=iPhone 8 Plus;lang=de-DE;ostype=iOS;clientIdentifier=Overseas",
                "accept-language": "de-DE;q=1, uk-DE;q=0.9, en-DE;q=0.8",
            },
            data: qs.stringify({
                account: this.config.username,
                app_id: "niu_fksss2ws",
                grant_type: "password",
                password: crypto.createHash("md5").update(this.config.password).digest("hex"),
                scope: "base",
            }),
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                if (res.data.data && res.data.data.token) {
                    this.session = res.data.data.token;
                    this.setState("info.connection", true, true);
                    return;
                }
                this.log.error(JSON.stringify(res.data));
            })
            .catch((error) => {
                this.log.error(error);
                if (error.response) {
                    this.log.error(JSON.stringify(error.response.data));
                }
            });
    }
    async getDeviceList() {
        await this.requestClient({
            method: "get",
            url: "https://app-api-fk.niu.com/v5/scooter/list",
            headers: {
                accept: "*/*",
                token: this.session.access_token,
                "accept-language": "de",
            },
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                if (!res.data.data.items) {
                    this.log.error("No devices found");
                    return;
                }
                for (const device of res.data.data.items) {
                    let vin = device.sn_id; // Alternative datapoint for serial number
                    if (device.sn) {
                        vin = device.sn; // original serial number
                    }

                    this.deviceArray.push(vin);
                    let name = device.scooter_name;
                    if (device.sku_name) {
                        name += " " + device.sku_name;
                    }
                    await this.setObjectNotExistsAsync(vin, {
                        type: "device",
                        common: {
                            name: name,
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync(vin + ".remote", {
                        type: "channel",
                        common: {
                            name: "Remote Controls",
                        },
                        native: {},
                    });
                    await this.setObjectNotExistsAsync(vin + ".general", {
                        type: "channel",
                        common: {
                            name: "General Information",
                        },
                        native: {},
                    });

                    const remoteArray = [{ command: "Refresh", name: "True = Refresh" }];
                    remoteArray.forEach((remote) => {
                        this.setObjectNotExists(vin + ".remote." + remote.command, {
                            type: "state",
                            common: {
                                name: remote.name || "",
                                type: remote.type || "boolean",
                                role: remote.role || "boolean",
                                write: true,
                                read: true,
                            },
                            native: {},
                        });
                    });
                    this.json2iob.parse(vin + ".general", device);
                }
            })
            .catch((error) => {
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
            });
    }

    async updateDevices() {
        const statusArray = [
            {
                path: "battery_info_health",
                url: "https://app-api-fk.niu.com/v3/motor_data/battery_info/health?sn=$vin",
                desc: "Status of the battery health",
            },
            {
                path: "battery_info",
                url: "https://app-api-fk.niu.com/v3/motor_data/battery_info?sn=$vin",
                desc: "Status of the battery info",
            },
            {
                path: "status",
                url: "https://app-api-fk.niu.com/v5/scooter/motor_data/index_info?sn=$vin",
                desc: "Status of the scooter",
            },
            {
                path: "scooter_info", // A lot of Infos about the scooter; e.g. position, battery, last track and much more
                url: "https://app-api-fk.niu.com/v3/motor_data/index_info?sn=$vin",

                desc: "More Information of the scooter",
            },
            {
                path: "track",
                url: "https://app-api-fk.niu.com/v5/track/list/v2",
                desc: "Tracks of the scooter",
                method: "post",
            },
            {
                path: "cycling_statistics.day", // daily statistics
                url: "https://app-api-fk.niu.com/v3/motor_data/cycling_statistics?sortby=1&sn=$vin",
                desc: "Cycling statistics by day of the scooter",
            },
            {
                path: "cycling_statistics.week", // weekly statistics
                url: "https://app-api-fk.niu.com/v3/motor_data/cycling_statistics?sortby=2&sn=$vin",
                desc: "Cycling statistics by week of the scooter",
            },
            {
                path: "cycling_statistics.month", // monthly statistics
                url: "https://app-api-fk.niu.com/v3/motor_data/cycling_statistics?sortby=3&sn=$vin",
                desc: "Cycling statistics by month of the scooter",
            },
        ];

        const headers = {
            accept: "*/*",
            token: this.session.access_token,
            "accept-language": "de",
            "user-agent": this.userAgent,
        };
        for (const vin of this.deviceArray) {
            for (const element of statusArray) {
                const url = element.url.replace("$vin", vin);
                const data = {
                    sn: vin,
                    index: "0",
                    token: this.session.access_token,
                    pagesize: 10,
                };
                await this.requestClient({
                    method: element.method || "get",
                    url: url,
                    headers: headers,
                    data: data,
                })
                    .then((res) => {
                        this.log.debug(JSON.stringify(res.data));
                        if (!res.data) {
                            return;
                        }
                        let data = res.data;
                        if (data.data) {
                            data = data.data;
                        }
                        if (element.path === "battery_info") {
                            delete data.batteries.compartmentA;
                        }
                        const forceIndex = true;
                        const preferedArrayName = null;

                        this.json2iob.parse(vin + "." + element.path, data, { forceIndex: forceIndex, preferedArrayName: preferedArrayName, channelName: element.desc });
                    })
                    .catch((error) => {
                        if (error.response) {
                            if (error.response.status === 401) {
                                error.response && this.log.debug(JSON.stringify(error.response.data));
                                this.log.info(element.path + " receive 401 error. Refresh Token in 60 seconds");
                                this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
                                this.refreshTokenTimeout = setTimeout(() => {
                                    this.refreshToken();
                                }, 1000 * 60);

                                return;
                            }
                        }
                        this.log.error(url);
                        this.log.error(error);
                        error.response && this.log.error(JSON.stringify(error.response.data));
                    });
            }
        }
    }
    async refreshToken() {
        if (!this.session) {
            this.log.error("No session found relogin");
            await this.login();
            return;
        }
        await this.requestClient({
            method: "post",
            url: "https://account-fk.niu.com/v3/api/oauth2/token",
            headers: {
                Accept: "*/*",
                "Accept-Language": "de",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data: qs.stringify({
                app_id: "niu_fksss2ws",
                grant_type: "refresh_token",
                refresh_token: this.session.refresh_token,
            }),
        })
            .then((res) => {
                this.log.debug(JSON.stringify(res.data));
                this.session = res.data;
                this.setState("info.connection", true, true);
            })
            .catch((error) => {
                this.log.error("refresh token failed");
                this.log.error(error);
                error.response && this.log.error(JSON.stringify(error.response.data));
                this.log.error("Start relogin in 1min");
                this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
                this.reLoginTimeout = setTimeout(() => {
                    this.login();
                }, 1000 * 60 * 1);
            });
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setState("info.connection", false, true);
            this.refreshTimeout && clearTimeout(this.refreshTimeout);
            this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
            this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
            this.updateInterval && clearInterval(this.updateInterval);
            this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (state) {
            if (!state.ack) {
                const deviceId = id.split(".")[2];
                const command = id.split(".")[4];
                if (id.split(".")[3] !== "remote") {
                    return;
                }

                if (command === "Refresh") {
                    this.updateDevices();
                }
                const data = {};
                this.log.debug(JSON.stringify(data));

                await this.requestClient({
                    method: "post",
                    url: "",
                    headers: {
                        accept: "*/*",
                        "content-type": "application/json",
                        "accept-language": "de",
                        authorization: "Bearer " + this.session.access_token,
                    },
                    data: data,
                })
                    .then((res) => {
                        this.log.info(JSON.stringify(res.data));
                        return res.data;
                    })
                    .catch((error) => {
                        this.log.error(error);
                        if (error.response) {
                            this.log.error(JSON.stringify(error.response.data));
                        }
                    });
                this.refreshTimeout && clearTimeout(this.refreshTimeout);
                this.refreshTimeout = setTimeout(async () => {
                    await this.updateDevices();
                }, 10 * 1000);
            }
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Niu(options);
} else {
    // otherwise start the instance directly
    new Niu();
}
