/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import { TOAST_DEFAULT_TIMEOUT } from '@nextcloud/dialogs'
import { t } from '@nextcloud/l10n'

/**
 * Helper to warn the user if they are talking while muted.
 *
 * The WebRTC helper emits events when it detects that the user is speaking
 * while muted; this helper shows a warning to the user based on those
 * events.
 *
 * The warning is not immediately shown, though; the WebRTC helper flags
 * even short sounds as "speaking" (provided they are strong enough), so to
 * prevent unnecessary warnings the user has to speak for a few seconds for
 * the warning to be shown. On the other hand, the warning is hidden as soon
 * as the WebRTC helper detects that the speaking has stopped; in this case
 * there is no delay, as the helper itself has a delay before emitting the
 * event.
 *
 * The way of warning the user changes depending on whether Talk is visible
 * or not; if it is visible the warning is shown in the Talk UI, but if it
 * is not it is shown using a browser notification, which will be visible
 * to the user even if the browser window is not in the foreground (provided
 * the user granted the permissions to receive notifications from the site).
 *
 * @param {object} LocalMediaModel the model that emits "speakingWhileMuted"
 * events.
 */
export default function SpeakingWhileMutedWarner(LocalMediaModel) {
	this._model = LocalMediaModel
	this._startedSpeakingTimeout = undefined
	this._startedShowWarningTimeout = undefined

	/** Public properties to use in Vue components */
	this.message = t('spreed', 'You seem to be talking while muted, please unmute yourself for others to hear you')
	this.showPopup = false

	this._handleSpeakingWhileMutedChangeBound = this._handleSpeakingWhileMutedChange.bind(this)

	this._model.on('change:speakingWhileMuted', this._handleSpeakingWhileMutedChangeBound)
}
SpeakingWhileMutedWarner.prototype = {

	destroy() {
		this._hideWarning()
		this._model.off('change:speakingWhileMuted', this._handleSpeakingWhileMutedChangeBound)
	},

	_handleSpeakingWhileMutedChange(model, speakingWhileMuted) {
		if (speakingWhileMuted) {
			this._handleSpeakingWhileMuted()
		} else {
			this._handleStoppedSpeakingWhileMuted()
		}
	},

	_handleSpeakingWhileMuted() {
		this._startedSpeakingTimeout = setTimeout(function() {
			delete this._startedSpeakingTimeout

			this._showWarning()
		}.bind(this), 3000)
	},

	_handleStoppedSpeakingWhileMuted() {
		if (this._startedSpeakingTimeout) {
			clearTimeout(this._startedSpeakingTimeout)
			delete this._startedSpeakingTimeout
		}

		this._hideWarning()
	},

	_showWarning() {
		if (!document.hidden) {
			this.showPopup = true
		} else {
			this._pendingBrowserNotification = true

			this._showBrowserNotification().catch(function() {
				if (this._pendingBrowserNotification) {
					this._pendingBrowserNotification = false

					this.showPopup = true
				}
			}.bind(this))
		}

		this._startedShowWarningTimeout = setTimeout(function() {
			delete this._startedShowWarningTimeout

			this._hideWarning()
		}.bind(this), TOAST_DEFAULT_TIMEOUT)
	},

	_showBrowserNotification() {
		return new Promise(function(resolve, reject) {
			if (this._browserNotification) {
				resolve()

				return
			}

			if (!Notification) {
				// The browser does not support the Notification API.
				reject()

				return
			}

			if (Notification.permission === 'denied') {
				reject()

				return
			}

			if (Notification.permission === 'granted') {
				this._pendingBrowserNotification = false
				this._browserNotification = new Notification(this.message)
				resolve()

				return
			}

			Notification.requestPermission().then(function(permission) {
				if (permission === 'granted') {
					if (this._pendingBrowserNotification) {
						this._pendingBrowserNotification = false
						this._browserNotification = new Notification(this.message)
					}
					resolve()
				} else {
					reject()
				}
			}.bind(this))
		}.bind(this))
	},

	_hideWarning() {
		this._pendingBrowserNotification = false

		if (this.showPopup) {
			this.showPopup = false
		}

		if (this._browserNotification) {
			this._browserNotification.close()

			this._browserNotification = null
		}

		if (this._startedShowWarningTimeout) {
			clearTimeout(this._startedShowWarningTimeout)
			delete this._startedShowWarningTimeout
		}
	},

}
