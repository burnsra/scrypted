import sdk, { Settings, MixinProvider, ScryptedDeviceBase, ScryptedDeviceType, Setting, ScryptedInterface, ScryptedInterfaceProperty, MixinDeviceBase, Camera, MediaObject } from '@scrypted/sdk';
import { Bridge, Categories, Characteristic, HAPStorage, PublishInfo, Service } from './hap';
import os from 'os';
import { HomeKitSession, SnapshotThrottle, supportedTypes } from './common';
import './types'
import { CameraMixin } from './camera-mixin';
import { maybeAddBatteryService } from './battery';
import { randomBytes } from 'crypto';
import qrcode from 'qrcode';
import packageJson from "../package.json";
import { randomPinCode } from './pincode';

const { systemManager } = sdk;

HAPStorage.storage();
class HAPLocalStorage {
    initSync() {

    }
    getItem(key: string): any {
        const data = localStorage.getItem(key);
        if (!data)
            return;
        return JSON.parse(data);
    }
    setItemSync(key: string, value: any) {
        localStorage.setItem(key, JSON.stringify(value));
    }
    removeItemSync(key: string) {
        localStorage.removeItem(key);
    }

    persistSync() {

    }
}

(HAPStorage as any).INSTANCE.localStore = new HAPLocalStorage();

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

if (!localStorage.getItem('uuid')) {
    localStorage.setItem('uuid', uuidv4());
}

const uuid = localStorage.getItem('uuid');


const includeToken = 4;

class HomeKit extends ScryptedDeviceBase implements MixinProvider, Settings, HomeKitSession {
    bridge = new Bridge('Scrypted', uuid);
    snapshotThrottles = new Map<string, SnapshotThrottle>();
    pincode = randomPinCode();

    constructor() {
        super();
        this.start();
    }

    getUsername() {
        let username = this.storage.getItem("mac");

        if (!username) {
            username = (Object.entries(os.networkInterfaces()).filter(([iface]) => iface.startsWith('en') || iface.startsWith('wlan')) as any)
                .flat().map(([, entry]) => entry).find(i => i && (i.family === 'IPv4' || i.family === 'IPv6'))?.mac;

            if (!username) {
                const buffers = [];
                for (let i = 0; i < 6; i++) {
                    buffers.push(randomBytes(1).toString('hex'));
                }
                username = buffers.join(':');
            }
            this.storage.setItem('mac', username);
        }
        return username;
    }

    async getSettings(): Promise<Setting[]> {
        return [
            {
                title: "Manual Pairing Code",
                key: "pairingCode",
                readonly: true,
                value: this.pincode,
            },
            {
                title: "Camera QR Code",
                key: "qrCode",
                readonly: true,
                value: "The Pairing QR Code can be viewed in the 'Console'",
            },
            {
                title: "Username Override",
                value: this.getUsername(),
                key: "mac",
            },
            {
                title: 'Bridge Address',
                value: localStorage.getItem('addressOverride'),
                key: 'addressOverride',
                description: 'Override the default network address used by the Scrypted bridge. Set this to your wired IP if connected by both wired and wireless.'
            },
            {
                title: 'Never Wait for Snapshots',
                value: (localStorage.getItem('blankSnapshots') === 'true').toString(),
                key: 'blankSnapshots',
                description: 'Send blank images instead of waiting snapshots. Improves up HomeKit responsiveness when bridging a large number of cameras.',
                type: 'boolean'
            }
        ]
    }

    async putSetting(key: string, value: string | number | boolean): Promise<void> {
        this.storage.setItem(key, value.toString());
    }

    async start() {
        let defaultIncluded: any;
        try {
            defaultIncluded = JSON.parse(this.storage.getItem('defaultIncluded'));
        }
        catch (e) {
            defaultIncluded = {};
        }

        const plugins = await systemManager.getComponent('plugins');

        const accessoryIds = new Set<string>();

        for (const id of Object.keys(systemManager.getSystemState())) {
            const device = systemManager.getDeviceById(id);
            const supportedType = supportedTypes[device.type];
            if (!supportedType?.probe(device))
                continue;

            try {
                const mixins = (device.mixins || []).slice();
                if (!mixins.includes(this.id)) {
                    if (defaultIncluded[device.id] === includeToken)
                        continue;
                    mixins.push(this.id);
                    await plugins.setMixins(device.id, mixins);
                    defaultIncluded[device.id] = includeToken;
                }

            }
            catch (e) {
                console.error('error while checking device if syncable', e);
                continue;
            }

            this.console.log('adding', device.name);

            const accessory = supportedType.getAccessory(device, this);
            if (accessory) {
                accessoryIds.add(id);

                maybeAddBatteryService(device, accessory);

                const deviceInfo = device.info;
                if (deviceInfo) {
                    const info = accessory.getService(Service.AccessoryInformation)!;
                    if (deviceInfo.manufacturer)
                        info.setCharacteristic(Characteristic.Manufacturer, deviceInfo.manufacturer);
                    if (deviceInfo.model)
                        info.setCharacteristic(Characteristic.Model, deviceInfo.model);
                    if (deviceInfo.serialNumber)
                        info.setCharacteristic(Characteristic.SerialNumber, deviceInfo.serialNumber);
                    if (deviceInfo.firmware)
                        info.setCharacteristic(Characteristic.FirmwareRevision, deviceInfo.firmware);
                    if (deviceInfo.version)
                        info.setCharacteristic(Characteristic.HardwareRevision, deviceInfo.version);
                }

                if (supportedType.noBridge) {
                    accessory.publish({
                        username: '12:34:45:54:24:44',
                        pincode: this.pincode,
                        port: Math.round(Math.random() * 30000 + 10000),
                        category: Categories.TELEVISION,
                    })
                }
                else {
                    this.bridge.addBridgedAccessory(accessory);
                }
            }
        }

        this.storage.setItem('defaultIncluded', JSON.stringify(defaultIncluded));

        const username = this.getUsername();

        const info = this.bridge.getService(Service.AccessoryInformation)!;
        info.setCharacteristic(Characteristic.Manufacturer, "scrypted.app");
        info.setCharacteristic(Characteristic.Model, "scrypted");
        info.setCharacteristic(Characteristic.SerialNumber, username);
        info.setCharacteristic(Characteristic.FirmwareRevision, packageJson.version);

        const publishInfo: PublishInfo = {
            username: username,
            port: Math.round(Math.random() * 30000 + 10000),
            pincode: this.pincode,
            category: Categories.BRIDGE,
            addIdentifyingMaterial: true,
        };

        this.bridge.publish(publishInfo, true);

        qrcode.toString(this.bridge.setupURI(), {
            type: 'terminal',
        }, (e, code) => {
            this.console.log('Pairing QR Code:')
            this.console.log(code);
        })

        systemManager.listen((eventSource, eventDetails, eventData) => {
            if (eventDetails.eventInterface !== ScryptedInterface.ScryptedDevice)
                return;

            if (!eventDetails.changed)
                return;

            if (!eventDetails.property)
                return;

            if (eventDetails.property !== ScryptedInterfaceProperty.id) {
                if (!accessoryIds.has(eventSource?.id))
                    return;
            }

            const device = systemManager.getDeviceById(eventSource?.id);
            this.console.log('restart event', eventSource?.id, eventDetails.property, eventData);
            this.log.a(`${device.name} was updated. Reload the HomeKit plugin to sync these changes.`);
            // deviceManager.requestRestart();
        });
    }

    async canMixin(type: ScryptedDeviceType, interfaces: string[]) {
        const supportedType = supportedTypes[type];
        if (!supportedType?.probe({
            interfaces,
            type,
        })) {
            return null;
        }

        if ((type === ScryptedDeviceType.Camera || type === ScryptedDeviceType.Doorbell)
            && interfaces.includes(ScryptedInterface.VideoCamera)) {
            return [ScryptedInterface.Settings];
        }
        return [];
    }
    getMixin(mixinDevice: any, mixinDeviceInterfaces: ScryptedInterface[], mixinDeviceState: { [key: string]: any }) {
        if ((mixinDeviceState.type === ScryptedDeviceType.Camera || mixinDeviceState.type === ScryptedDeviceType.Doorbell)
            && mixinDeviceInterfaces.includes(ScryptedInterface.VideoCamera)) {
            return new CameraMixin(mixinDevice, mixinDeviceInterfaces, mixinDeviceState, this.nativeId);
        }
        return mixinDevice;
    }

    async releaseMixin(id: string, mixinDevice: any) {
        const device = systemManager.getDeviceById(id);
        if (device.mixins?.includes(this.id)) {
            return;
        }
        this.console.log('release mixin', id);
        this.log.a(`${device.name} was removed. Reload the HomeKit plugin to sync these changes.`);
        // deviceManager.requestRestart();
    }
}

export default new HomeKit();
