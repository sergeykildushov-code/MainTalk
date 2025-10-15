/**
 * SPDX-FileCopyrightText: 2019 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import conversationsStore from './conversationsStore.js'
import fileUploadStore from './fileUploadStore.js'
import messagesStore from './messagesStore.js'
import participantsStore from './participantsStore.js'

export default {
	modules: {
		conversationsStore,
		fileUploadStore,
		messagesStore,
		participantsStore,
	},

	mutations: {},

	strict: process.env.NODE_ENV !== 'production',
}
