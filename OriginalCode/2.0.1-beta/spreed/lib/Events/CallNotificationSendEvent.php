<?php

declare(strict_types=1);
/**
 * SPDX-FileCopyrightText: 2023 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Talk\Events;

use OCA\Talk\Participant;
use OCA\Talk\Room;

/**
 * @internal This event is not part of the public API and you should not rely on it.
 */
class CallNotificationSendEvent extends ARoomEvent {

	public function __construct(
		Room $room,
		protected ?Participant $actor,
		protected Participant $target,
	) {
		parent::__construct($room);
	}

	public function getActor(): ?Participant {
		return $this->actor;
	}

	public function getTarget(): Participant {
		return $this->target;
	}
}
