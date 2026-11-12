package service

import (
	"os"
	"strings"
)

// BackgroundConsumersSuppressed reports the staging switch.
// REDIS_KEY_PREFIX is not read here. The Redis client has no key prefix, so a
// staging: value does not rename queues, leader locks, or schedules.
func BackgroundConsumersSuppressed() bool {
	return strings.TrimSpace(os.Getenv("SUB2API_BACKGROUND_CONSUMERS")) == "off"
}
