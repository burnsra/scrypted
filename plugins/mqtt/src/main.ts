// https://developer.scrypted.app/#getting-started
// package.json contains the metadata (name, interfaces) about this device
// under the "scrypted" key.
import axios from 'axios';
import { Settings, Setting, DeviceProvider, OnOff, ScryptedDeviceBase, ScryptedInterface, ScryptedDeviceType, Scriptable, ScriptSource, ScryptedInterfaceDescriptors } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { monacoEvalDefaults } from './monaco';
import { scryptedEval } from './scrypted-eval';
import { MqttClient, MqttSubscriptions } from './api/mqtt-client';
import { connect, Client, IClientSubscribeOptions, ClientSubscribeCallback } from 'mqtt';
import aedes from 'aedes';
import net from 'net';
import ws from 'websocket-stream';
import http from 'http';
import { MqttDeviceBase } from './api/mqtt-device-base';
import { MqttAutoDiscoveryDevice, MqttAutoDiscoveryProvider } from './autodiscovery/autodiscovery';

const loopbackLight = require("!!raw-loader!./examples/loopback-light.ts");

const methodInterfaces: { [method: string]: string } = {};
for (const desc of Object.values(ScryptedInterfaceDescriptors)) {
    for (const method of desc.methods) {
        methodInterfaces[method] = desc.name;
    }
}

const { log, deviceManager } = sdk;

class MqttDevice extends MqttDeviceBase implements Scriptable {
    handler: any;

    constructor(nativeId: string) {
        super(nativeId);

        this.bind();
    }

    async saveScript(source: ScriptSource): Promise<void> {
        this.storage.setItem('data', JSON.stringify(source));
        this.bind();
    }
    async loadScripts(): Promise<{ [filename: string]: ScriptSource; }> {
        try {
            const ret = JSON.parse(this.storage.getItem('data'));
            ret.monacoEvalDefaults = monacoEvalDefaults;
            ret.name = 'MQTT Handler';
            ret.script = ret.script || loopbackLight;
            return {
                'mqtt.ts': ret,
            };
        }
        catch (e) {
            return {
                'mqtt.ts': {
                    name: 'MQTT Handler',
                    script: loopbackLight,
                    monacoEvalDefaults,
                },
            }
        }
    }

    async bind() {
        const scripts = await this.loadScripts();
        const script = scripts['mqtt.ts'];
        await this.eval(script);
    }

    async eval(source: ScriptSource, variables?: {
        [name: string]:
        // package.json contains the metadata (name, interfaces) about this device
        // under the "scrypted" key.
        any;
    }): Promise<any> {
        const { script } = source;
        try {
            this.handler = undefined;

            const client = this.connectClient();

            const allInterfaces: string[] = [
                ScryptedInterface.Scriptable,
                ScryptedInterface.Settings,
            ]

            const mqtt: MqttClient = {
                subscribe: (subscriptions: MqttSubscriptions, options?: any) => {
                    for (const topic of Object.keys(subscriptions)) {
                        const fullTopic = this.pathname + topic;
                        const cb = subscriptions[topic];
                        if (options) {
                            client.subscribe(fullTopic, options)
                        }
                        else {
                            client.subscribe(fullTopic)
                        }
                        client.on('message', (messageTopic, message) => {
                            if (fullTopic !== messageTopic && fullTopic !== '/' + messageTopic)
                                return;
                            this.console.log('mqtt message', topic, message.toString());
                            cb({
                                get text() {
                                    return message.toString();
                                },
                                get json() {
                                    try {
                                        return JSON.parse(message.toString());
                                    }
                                    catch (e) {
                                    }
                                },
                                get buffer() {
                                    return message;
                                }
                            })
                        });
                    }
                },
                handle: <T>(handler?: T & object) => {
                    this.handler = handler;
                },
                handleTypes: (...interfaces: ScryptedInterface[]) => {
                    allInterfaces.push(...interfaces);
                },
                publish: async (topic: string, value: any) => {
                    if (typeof value === 'object')
                        value = JSON.stringify(value);
                    if (value.constructor.name !== Buffer.name)
                        value = value.toString();
                    client.publish(this.pathname + topic, value);
                }
            }
            await scryptedEval(this, script, {
                mqtt,
            });

            const handler = this.handler || {};
            for (const method of Object.keys(handler)) {
                const iface = methodInterfaces[method];
                if (iface)
                    allInterfaces.push(iface);
            }

            Object.assign(this, handler);

            await deviceManager.onDeviceDiscovered({
                nativeId: this.nativeId,
                interfaces: allInterfaces,
                type: ScryptedDeviceType.Unknown,
                name: this.providedName,
            });

            this.console.log('MQTT device started.');
        }
        catch (e) {
            this.log.a('There was an error starting the MQTT handler. Check the Console.');
            this.console.error(e);
        }
    }
}

class MqttProvider extends ScryptedDeviceBase implements DeviceProvider, Settings {
    devices = new Map<string, any>();
    netServer: net.Server;
    httpServer: http.Server;

    constructor(nativeId?: string) {
        super(nativeId);

        this.maybeEnableBroker();

        for (const deviceId of deviceManager.getNativeIds()) {
            if (deviceId)
                this.getDevice(deviceId);
        }
    }

    async getSettings(): Promise<Setting[]> {
        return [
            {
                key: 'new-device',
                title: 'Add MQTT Custom Handler',
                placeholder: 'Device name, e.g.: Kitchen Light, Office Light, etc',
            },
            {
                key: 'new-autodiscovery',
                title: 'Add MQTT Autodiscovery',
                placeholder: 'Autodiscovery name, e.g.: Zwavejs2Mqtt, Zibgee2Mqtt, etc',
            },
            {
                title: 'Enable MQTT Broker',
                key: 'enableBroker',
                description: 'Enable the Aedes MQTT Broker.',
                group: 'MQTT Broker',
                type: 'boolean',
                value: (this.storage.getItem('enableBroker') === 'true').toString(),
            },
            {
                title: 'TCP Port',
                key: 'tcpPort',
                description: 'The port to use for TCP connections',
                placeholder: '1883',
                type: 'number',
                group: 'MQTT Broker',
                value: this.storage.getItem('tcpPort'),
            },
            {
                title: 'HTTP Port',
                key: 'httpPort',
                description: 'The port to use for HTTP connections',
                placeholder: '8888',
                type: 'number',
                group: 'MQTT Broker',
                value: this.storage.getItem('httpPort'),
            },
        ]
    }

    maybeEnableBroker() {
        this.httpServer?.close();
        this.netServer?.close();

        if (this.storage.getItem('enableBroker') !== 'true')
            return;
        const instance = aedes();
        this.netServer = net.createServer(instance.handle);
        const tcpPort = parseInt(this.storage.getItem('tcpPort')) || 1883;
        const httpPort = parseInt(this.storage.getItem('httpPort')) || 8888;
        this.netServer.listen(tcpPort);
        this.httpServer = http.createServer();
        ws.createServer({ server: this.httpServer }).on('connection', instance.handle);
        this.httpServer.listen(httpPort);

        instance.on('publish', packet => {
            if (!packet.payload)
                return;
            const preview = packet.payload.length > 2048 ? '[large payload suppressed]' : packet.payload.toString();
            this.console.log('mqtt message', packet.topic, preview);
        });
    }

    async putSetting(key: string, value: string | number) {
        this.storage.setItem(key, value.toString());

        if (key === 'enableBroker') {
            this.maybeEnableBroker();
            return;
        }

        if (key === 'new-device') {

            // generate a random id
            var nativeId = Math.random().toString();
            var name = value.toString();

            deviceManager.onDeviceDiscovered({
                nativeId,
                name: name,
                interfaces: [ScryptedInterface.Scriptable, ScryptedInterface.Settings],
                type: ScryptedDeviceType.Unknown,
            });

            var text = `New MQTT Device ${name} ready. Check the notification area to continue configuration.`;
            log.a(text);
            log.clearAlert(text);
            return;
        }

        if (key === 'new-autodiscovery') {

            // generate a random id
            var nativeId = 'autodiscovery:' + Math.random().toString();
            var name = value.toString();

            deviceManager.onDeviceDiscovered({
                nativeId,
                name: name,
                interfaces: [ScryptedInterface.DeviceProvider, ScryptedInterface.Settings],
                type: ScryptedDeviceType.DeviceProvider,
            });

            var text = `New MQTT Autodiscovery ${name} ready. Check the notification area to continue configuration.`;
            log.a(text);
            log.clearAlert(text);
            return;
        }
    }

    async discoverDevices(duration: number) {
    }

    createMqttDevice(nativeId: string): MqttDevice {
        return;
    }

    getDevice(nativeId: string) {
        let ret = this.devices.get(nativeId);
        if (!ret) {
            if (nativeId.startsWith('autodiscovery:')) {
                ret = new MqttAutoDiscoveryProvider(nativeId);
            }
            else if (nativeId.startsWith('0.')) {
                ret = new MqttDevice(nativeId);
            }
            if (ret)
                this.devices.set(nativeId, ret);
        }
        return ret;
    }
}

export default new MqttProvider();