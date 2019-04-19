/*
Copyright 2015, 2016 OpenMarket Ltd
Copyright 2017 Vector Creations Ltd
Copyright 2017 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import MatrixClientPeg from './MatrixClientPeg';
import PlatformPeg from './PlatformPeg';
import TextForEvent from './TextForEvent';
import Analytics from './Analytics';
import Avatar from './Avatar';
import dis from './dispatcher';
import sdk from './index';
import { _t } from './languageHandler';
import Modal from './Modal';
import SettingsStore, {SettingLevel} from "./settings/SettingsStore";

/*
 * Dispatches:
 * {
 *   action: "notifier_enabled",
 *   value: boolean
 * }
 */

const MAX_PENDING_ENCRYPTED = 20;

const Notifier = {
    notifsByRoom: {},

    // A list of event IDs that we've received but need to wait until
    // they're decrypted until we decide whether to notify for them
    // or not
    pendingEncryptedEventIds: [],

    notificationMessageForEvent: function(ev) {
        return TextForEvent.textForEvent(ev);
    },

    _displayPopupNotification: function(ev, room) {
        const plaf = PlatformPeg.get();
        if (!plaf) {
            return;
        }
        if (!plaf.supportsNotifications() || !plaf.maySendNotifications()) {
            return;
        }
        if (global.document.hasFocus()) {
            return;
        }

        let msg = this.notificationMessageForEvent(ev);
        if (!msg) return;

        let title;
        if (!ev.sender || room.name === ev.sender.name) {
            title = room.name;
            // notificationMessageForEvent includes sender,
            // but we already have the sender here
            if (ev.getContent().body) msg = ev.getContent().body;
        } else if (ev.getType() === 'm.room.member') {
            // context is all in the message here, we don't need
            // to display sender info
            title = room.name;
        } else if (ev.sender) {
            title = ev.sender.name + " (" + room.name + ")";
            // notificationMessageForEvent includes sender,
            // but we've just out sender in the title
            if (ev.getContent().body) msg = ev.getContent().body;
        }

        if (!this.isBodyEnabled()) {
            msg = '';
        }

        const avatarUrl = ev.sender ? Avatar.avatarUrlForMember(ev.sender, 40, 40, 'crop') : null;
        const notif = plaf.displayNotification(title, msg, avatarUrl, room);

        // if displayNotification returns non-null,  the platform supports
        // clearing notifications later, so keep track of this.
        if (notif) {
            if (this.notifsByRoom[ev.getRoomId()] === undefined) this.notifsByRoom[ev.getRoomId()] = [];
            this.notifsByRoom[ev.getRoomId()].push(notif);
        }
    },

    _getSoundForRoom: async function(room) {
        // We do no caching here because the SDK caches the event content
        // and the browser will cache the sound.
        const ev = await room.getAccountData("uk.half-shot.notification.sound");
        if (!ev) {
            return null;
        }
        let url = ev.getContent().url;
        if (!url) {
            console.warn(`${room.roomId} has custom notification sound event, but no url key`);
            return null;
        }
        url = MatrixClientPeg.get().mxcUrlToHttp(url);
        this.notifSoundsByRoom.set(room.roomId, url);
        return url;
    },

    _playAudioNotification: function(ev, room) {
        _getSoundForRoom(room).then((soundUrl) => {
            console.log(`Got sound ${soundUrl || "default"} for ${room.roomId}`);
            // XXX: How do we ensure this is a sound file and not
            // going to be exploited?
            const selector = document.querySelector(`audio source[src='${soundUrl}']`) || "#messageAudio";
            let audioElement = null;
            if (!selector) {
                if (!soundUrl) {
                    console.error("Tried to play alert sound but missing #messageAudio")
                    return
                }
                audioElement = new HTMLAudioElement();
                let sourceElement = new HTMLSourceElement();
                // XXX: type
                sourceElement.src = soundUrl;
                audioElement.appendChild(sourceElement);
                document.appendChild(audioElement);
            } else {
                audioElement = selector.parentNode;
            }
            audioElement.play();
        });
    },

    start: function() {
        this.boundOnEvent = this.onEvent.bind(this);
        this.boundOnSyncStateChange = this.onSyncStateChange.bind(this);
        this.boundOnRoomReceipt = this.onRoomReceipt.bind(this);
        this.boundOnEventDecrypted = this.onEventDecrypted.bind(this);
        MatrixClientPeg.get().on('event', this.boundOnEvent);
        MatrixClientPeg.get().on('Room.receipt', this.boundOnRoomReceipt);
        MatrixClientPeg.get().on('Event.decrypted', this.boundOnEventDecrypted);
        MatrixClientPeg.get().on("sync", this.boundOnSyncStateChange);
        this.toolbarHidden = false;
        this.isSyncing = false;
    },

    stop: function() {
        if (MatrixClientPeg.get() && this.boundOnRoomTimeline) {
            MatrixClientPeg.get().removeListener('Event', this.boundOnEvent);
            MatrixClientPeg.get().removeListener('Room.receipt', this.boundOnRoomReceipt);
            MatrixClientPeg.get().removeListener('Event.decrypted', this.boundOnEventDecrypted);
            MatrixClientPeg.get().removeListener('sync', this.boundOnSyncStateChange);
        }
        this.isSyncing = false;
    },

    supportsDesktopNotifications: function() {
        const plaf = PlatformPeg.get();
        return plaf && plaf.supportsNotifications();
    },

    setEnabled: function(enable, callback) {
        const plaf = PlatformPeg.get();
        if (!plaf) return;

        // Dev note: We don't set the "notificationsEnabled" setting to true here because it is a
        // calculated value. It is determined based upon whether or not the master rule is enabled
        // and other flags. Setting it here would cause a circular reference.

        Analytics.trackEvent('Notifier', 'Set Enabled', enable);

        // make sure that we persist the current setting audio_enabled setting
        // before changing anything
        if (SettingsStore.isLevelSupported(SettingLevel.DEVICE)) {
            SettingsStore.setValue("audioNotificationsEnabled", null, SettingLevel.DEVICE, this.isEnabled());
        }

        if (enable) {
            // Attempt to get permission from user
            plaf.requestNotificationPermission().done((result) => {
                if (result !== 'granted') {
                    // The permission request was dismissed or denied
                    // TODO: Support alternative branding in messaging
                    const description = result === 'denied'
                        ? _t('Riot does not have permission to send you notifications - please check your browser settings')
                        : _t('Riot was not given permission to send notifications - please try again');
                    const ErrorDialog = sdk.getComponent('dialogs.ErrorDialog');
                    Modal.createTrackedDialog('Unable to enable Notifications', result, ErrorDialog, {
                        title: _t('Unable to enable Notifications'),
                        description,
                    });
                    return;
                }

                if (callback) callback();
                dis.dispatch({
                    action: "notifier_enabled",
                    value: true,
                });
            });
        } else {
            dis.dispatch({
                action: "notifier_enabled",
                value: false,
            });
        }
        // set the notifications_hidden flag, as the user has knowingly interacted
        // with the setting we shouldn't nag them any further
        this.setToolbarHidden(true);
    },

    isEnabled: function() {
        return this.isPossible() && SettingsStore.getValue("notificationsEnabled");
    },

    isPossible: function() {
        const plaf = PlatformPeg.get();
        if (!plaf) return false;
        if (!plaf.supportsNotifications()) return false;
        if (!plaf.maySendNotifications()) return false;

        return true; // possible, but not necessarily enabled
    },

    isBodyEnabled: function() {
        return this.isEnabled() && SettingsStore.getValue("notificationBodyEnabled");
    },

    isAudioEnabled: function() {
        return this.isEnabled() && SettingsStore.getValue("audioNotificationsEnabled");
    },

    setToolbarHidden: function(hidden, persistent = true) {
        this.toolbarHidden = hidden;

        Analytics.trackEvent('Notifier', 'Set Toolbar Hidden', hidden);

        // XXX: why are we dispatching this here?
        // this is nothing to do with notifier_enabled
        dis.dispatch({
            action: "notifier_enabled",
            value: this.isEnabled(),
        });

        // update the info to localStorage for persistent settings
        if (persistent && global.localStorage) {
            global.localStorage.setItem("notifications_hidden", hidden);
        }
    },

    shouldShowToolbar: function() {
        const client = MatrixClientPeg.get();
        if (!client) {
            return false;
        }
        const isGuest = client.isGuest();
        return !isGuest && this.supportsDesktopNotifications() &&
            !this.isEnabled() && !this._isToolbarHidden();
    },

    _isToolbarHidden: function() {
        // Check localStorage for any such meta data
        if (global.localStorage) {
            return global.localStorage.getItem("notifications_hidden") === "true";
        }

        return this.toolbarHidden;
    },

    onSyncStateChange: function(state) {
        if (state === "SYNCING") {
            this.isSyncing = true;
        } else if (state === "STOPPED" || state === "ERROR") {
            this.isSyncing = false;
        }
    },

    onEvent: function(ev) {
        if (!this.isSyncing) return; // don't alert for any messages initially
        if (ev.sender && ev.sender.userId === MatrixClientPeg.get().credentials.userId) return;

        // If it's an encrypted event and the type is still 'm.room.encrypted',
        // it hasn't yet been decrypted, so wait until it is.
        if (ev.isBeingDecrypted() || ev.isDecryptionFailure()) {
            this.pendingEncryptedEventIds.push(ev.getId());
            // don't let the list fill up indefinitely
            while (this.pendingEncryptedEventIds.length > MAX_PENDING_ENCRYPTED) {
                this.pendingEncryptedEventIds.shift();
            }
            return;
        }

        this._evaluateEvent(ev);
    },

    onEventDecrypted: function(ev) {
        // 'decrypted' means the decryption process has finished: it may have failed,
        // in which case it might decrypt soon if the keys arrive
        if (ev.isDecryptionFailure()) return;

        const idx = this.pendingEncryptedEventIds.indexOf(ev.getId());
        if (idx === -1) return;

        this.pendingEncryptedEventIds.splice(idx, 1);
        this._evaluateEvent(ev);
    },

    onRoomReceipt: function(ev, room) {
        if (room.getUnreadNotificationCount() === 0) {
            // ideally we would clear each notification when it was read,
            // but we have no way, given a read receipt, to know whether
            // the receipt comes before or after an event, so we can't
            // do this. Instead, clear all notifications for a room once
            // there are no notifs left in that room., which is not quite
            // as good but it's something.
            const plaf = PlatformPeg.get();
            if (!plaf) return;
            if (this.notifsByRoom[room.roomId] === undefined) return;
            for (const notif of this.notifsByRoom[room.roomId]) {
                plaf.clearNotification(notif);
            }
            delete this.notifsByRoom[room.roomId];
        }
    },

    _evaluateEvent: function(ev) {
        const room = MatrixClientPeg.get().getRoom(ev.getRoomId());
        const actions = MatrixClientPeg.get().getPushActionsForEvent(ev);
        if (actions && actions.notify) {
            if (this.isEnabled()) {
                this._displayPopupNotification(ev, room);
            }
            if (actions.tweaks.sound && this.isAudioEnabled()) {
                PlatformPeg.get().loudNotification(ev, room);
                this._playAudioNotification(ev, room);
            }
        }
    },
};

if (!global.mxNotifier) {
    global.mxNotifier = Notifier;
}

module.exports = global.mxNotifier;
