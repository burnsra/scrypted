const types = require('./types.generated.js');

class ScryptedDeviceBase {
    constructor(nativeId) {
        this.nativeId = nativeId;
    }

    get storage() {
        if (!this._storage) {
            this._storage = deviceManager.getDeviceStorage(this.nativeId);
        }
        return this._storage;
    }

    get log() {
        if (!this._log) {
            this._log = deviceManager.getDeviceLogger(this.nativeId);
        }
        return this._log;
    }

    get console() {
        if (!this._console) {
            this._console = deviceManager.getDeviceConsole(this.nativeId);
        }

        return this._console;
    }

    _lazyLoadDeviceState() {
        if (!this._deviceState) {
            if (this.nativeId) {
                this._deviceState = deviceManager.getDeviceState(this.nativeId);
            }
            else {
                this._deviceState = deviceManager.getDeviceState();
            }
        }
    }
}

class MixinDeviceBase {
    constructor(mixinDevice, mixinDeviceInterfaces, mixinDeviceState, mixinProviderNativeId) {
        this.mixinDevice = mixinDevice;
        this.mixinDevice = mixinDevice;
        this.mixinDeviceInterfaces = mixinDeviceInterfaces;
        this._deviceState = mixinDeviceState;
        this.mixinProviderNativeId = mixinProviderNativeId;
    }

    get storage() {
        if (!this._storage) {
            this._storage = deviceManager.getMixinStorage(this.id, this.mixinProviderNativeId);
        }
        return this._storage;
    }

    _lazyLoadDeviceState() {
    }

    release() {
    }
}

(function () {
    function _createGetState(state) {
        return function () {
            this._lazyLoadDeviceState();
            return this._deviceState[state];
        };
    }

    function _createSetState(state) {
        return function (value) {
            this._lazyLoadDeviceState();
            this._deviceState[state] = value;
        };
    }

    for (var field of Object.values(types.ScryptedInterfaceProperty)) {
        Object.defineProperty(ScryptedDeviceBase.prototype, field, {
            set: _createSetState(field),
            get: _createGetState(field),
        });
        Object.defineProperty(MixinDeviceBase.prototype, field, {
            set: _createSetState(field),
            get: _createGetState(field),
        });
    }
})();


const sdk = {
    ScryptedDeviceBase,
    MixinDeviceBase,
}

Object.assign(sdk, types);

module.exports = sdk;
module.exports.default = sdk;
