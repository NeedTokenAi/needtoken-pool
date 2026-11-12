package service

import (
	"os"
	"strings"
)

// BackgroundConsumersSuppressed reports the staging switch.
// REDIS_KEY_PREFIX is applied by the Redis client, not by this switch.
func BackgroundConsumersSuppressed() bool {
	return strings.TrimSpace(os.Getenv("SUB2API_BACKGROUND_CONSUMERS")) == "off"
}
