import sdk, { ScryptedDeviceBase, DeviceProvider, Settings, Setting, ScryptedDeviceType, VideoCamera, MediaObject, MediaStreamOptions, ScryptedInterface, FFMpegInput, Camera } from "@scrypted/sdk";
import { EventEmitter } from "stream";
import { recommendRebroadcast } from "./recommend";
import AxiosDigestAuth from '@koush/axios-digest-auth';
import https from 'https';

const { log, deviceManager, mediaManager } = sdk;

const httpsAgent = new https.Agent({
    rejectUnauthorized: false
});

export class RtspCamera extends ScryptedDeviceBase implements Camera, VideoCamera, Settings {
    snapshotAuth: AxiosDigestAuth;

    constructor(nativeId: string, public provider: RtspProvider) {
        super(nativeId);
    }

    async takePicture(): Promise<MediaObject> {
        const snapshotUrl = this.storage.getItem('snapshotUrl');
        if (!snapshotUrl) {
            throw new Error('RTSP Camera has no snapshot URL');
        }

        if (!this.snapshotAuth) {
            this.snapshotAuth = new AxiosDigestAuth({
                username: this.getUsername(),
                password: this.getPassword(),
            });
        }

        const response = await this.snapshotAuth.request({
            httpsAgent,
            method: "GET",
            responseType: 'arraybuffer',
            url: snapshotUrl,
        });

        return mediaManager.createMediaObject(Buffer.from(response.data), response.headers['Content-Type'] || 'image/jpeg');
    }

    async getVideoStreamOptions(): Promise<void | MediaStreamOptions[]> {
        return [
            {
                video: {
                },
                audio: this.isAudioDisabled() ? null : {},
            }
        ];
    }

    async getStreamUrl() {
        return this.storage.getItem("url");
    }

    isAudioDisabled() {
        return this.storage.getItem('noAudio') === 'true';
    }

    async getVideoStream(): Promise<MediaObject> {
        const url = new URL(await this.getStreamUrl());
        this.console.log('rtsp stream url', url.toString());
        const username = this.storage.getItem("username");
        const password = this.storage.getItem("password");
        if (username)
            url.username = username;
        if (password)
            url.password = password;

        const vso = await this.getVideoStreamOptions();
        const ret: FFMpegInput = {
            inputArguments: [
                "-rtsp_transport",
                "tcp",
                '-analyzeduration', '15000000',
                '-probesize', '10000000',
                "-reorder_queue_size",
                "1024",
                "-max_delay",
                "20000000",
                "-i",
                url.toString(),
            ],
            mediaStreamOptions: vso?.[0],
        };

        return mediaManager.createFFmpegMediaObject(ret);
    }

    async getUrlSettings(): Promise<Setting[]> {
        return [
            {
                key: 'url',
                title: 'RTSP Stream URL',
                placeholder: 'rtsp://192.168.1.100:4567/foo/bar',
                value: this.storage.getItem('url'),
            },
            {
                key: 'snapshotUrl',
                title: 'Snapshot URL',
                placeholder: 'http://192.168.1.100/snapshot.jpg',
                value: this.storage.getItem('snapshotUrl'),
                description: 'Optional: The snapshot URL that will returns the current JPEG image.'
            },
        ];
    }

    getUsername() {
        return this.storage.getItem('username');
    }

    getPassword() {
        return this.storage.getItem('password');
    }

    async getOtherSettings(): Promise<Setting[]> {
        return [];
    }

    async getSettings(): Promise<Setting[]> {
        return [
            {
                key: 'username',
                title: 'Username',
                value: this.getUsername(),
            },
            {
                key: 'password',
                title: 'Password',
                value: this.getPassword(),
                type: 'Password',
            },
            {
                key: 'noAudio',
                title: 'No Audio',
                description: 'Enable this setting if the stream does not have audio or to mute audio.',
                type: 'boolean',
                value: (this.isAudioDisabled()).toString(),
            },
            ...await this.getUrlSettings(),
            ...await this.getOtherSettings(),
        ];
    }

    async putSetting(key: string, value: string | number) {
        this.storage.setItem(key, value.toString());

        this.snapshotAuth = undefined;

        if (key === 'snapshotUrl') {
            const interfaces = this.providedInterfaces;
            if (!value)
                interfaces.filter(iface => iface !== ScryptedInterface.Camera)
            else
                interfaces.push(ScryptedInterface.Camera);

            this.provider.updateDevice(this.nativeId, this.providedName, interfaces);
        }
    }
}

export interface Destroyable {
    destroy(): void;
}

export abstract class RtspSmartCamera extends RtspCamera {
    lastListen = 0;

    constructor(nativeId: string, provider: RtspProvider) {
        super(nativeId, provider);
        this.listenLoop();
    }

    listener: EventEmitter & Destroyable;

    listenLoop() {
        this.lastListen = Date.now();
        this.listener = this.listenEvents();
        this.listener.on('error', e => {
            this.console.error('listen loop error, restarting in 10 seconds', e);
            const listenDuration = Date.now() - this.lastListen;
            const listenNext = listenDuration > 10000 ? 0 : 10000;
            setTimeout(() => this.listenLoop(), listenNext);
        });
    }

    async putSetting(key: string, value: string | number) {
        super.putSetting(key, value);

        this.listener.emit('error', new Error("new settings"));
    }

    async getUrlSettings() {
        const constructed = await this.getConstructedStreamUrl();
        return [
            {
                key: 'ip',
                title: 'Address',
                placeholder: '192.168.1.100[:554]',
                value: this.storage.getItem('ip'),
            },
            {
                key: 'httpPort',
                title: 'HTTP Port Override',
                placeholder: '80',
                value: this.storage.getItem('httpPort'),
            },
            {
                key: 'rtspUrlOverride',
                title: 'RTSP URL Override',
                description: "Override the RTSP URL if your camera is using a non default port, channel, or rebroadcasted through an NVR. Default: " + constructed,
                placeholder: constructed,
                value: this.storage.getItem('rtspUrlOverride'),
            },
        ];
    }

    getHttpAddress() {
        return `${this.storage.getItem('ip')}:${this.storage.getItem('httpPort') || 80}`;
    }

    getRtspUrlOverride() {
        return this.storage.getItem('rtspUrlOverride');
    }

    abstract getConstructedStreamUrl(): Promise<string>;
    abstract listenEvents(): EventEmitter & Destroyable;

    getRtspAddress() {
        return this.storage.getItem('ip');
    }

    async getStreamUrl() {
        return this.getRtspUrlOverride() || await this.getConstructedStreamUrl();
    }
}

export class RtspProvider extends ScryptedDeviceBase implements DeviceProvider, Settings {
    devices = new Map<string, any>();

    constructor(nativeId?: string) {
        super(nativeId);

        for (const camId of deviceManager.getNativeIds()) {
            if (camId)
                this.getDevice(camId);
        }

        recommendRebroadcast();
    }

    getAdditionalInterfaces() {
        return [
        ];
    }

    async getSettings(): Promise<Setting[]> {
        return [
            {
                key: 'new-camera',
                title: 'Add RTSP Camera',
                placeholder: 'Camera name, e.g.: Back Yard Camera, Baby Camera, etc',
            }
        ]
    }

    getInterfaces() {
        return [ScryptedInterface.VideoCamera,
        ScryptedInterface.Settings, ...this.getAdditionalInterfaces()];
    }

    updateDevice(nativeId: string, name: string, interfaces: string[], type?: ScryptedDeviceType) {
        deviceManager.onDeviceDiscovered({
            nativeId,
            name,
            interfaces,
            type: type || ScryptedDeviceType.Camera,
        });
    }

    async putSetting(key: string, value: string | number) {
        // generate a random id
        const nativeId = Math.random().toString();
        const name = value.toString();

        this.updateDevice(nativeId, name, this.getInterfaces());

        var text = `New Camera ${name} ready. Check the notification area to complete setup.`;
        log.a(text);
        log.clearAlert(text);
    }

    async discoverDevices(duration: number) {
    }

    createCamera(nativeId: string, provider: RtspProvider): RtspCamera {
        return new RtspCamera(nativeId, provider);
    }

    getDevice(nativeId: string) {
        let ret = this.devices.get(nativeId);
        if (!ret) {
            ret = this.createCamera(nativeId, this);
            if (ret)
                this.devices.set(nativeId, ret);
        }
        return ret;
    }
}
