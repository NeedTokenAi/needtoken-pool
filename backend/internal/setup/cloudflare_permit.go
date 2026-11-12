package setup

import (
	"errors"
	"os"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/config"
)

// RequireIsolatedWriterPermit allows this candidate to run only with isolated
// bindings. It does not stop or coordinate with the existing production process.
func RequireIsolatedWriterPermit() error {
	if !config.CloudflareProfileEnabled() {
		return nil
	}
	if strings.TrimSpace(os.Getenv("SUB2API_ISOLATION")) != "isolated" {
		return errors.New("cloudflare candidate requires SUB2API_ISOLATION=isolated")
	}
	if !nonTestWriterPermit(os.Getenv("SUB2API_WRITER_PERMIT")) {
		return errors.New("cloudflare candidate requires a non-test writer permit")
	}
	if err := requireAllowedDatabaseHost(); err != nil {
		return err
	}
	return requireBackgroundConsumersOff()
}

// allowedDatabaseHosts is the staging Neon endpoint and its pooler host.
// After cutover the live service keeps the existing production database.
// Staging rejects every other DATABASE_HOST, so it cannot connect to that
// database. Redis stays the existing Upstash and is not host-checked.
// The production DSN is not stored here.
var allowedDatabaseHosts = map[string]struct{}{
	"ep-aged-sunset-b33os2qw.c-4.ap-southeast-1.aws.neon.tech":        {},
	"ep-aged-sunset-b33os2qw-pooler.c-4.ap-southeast-1.aws.neon.tech": {},
}

func requireAllowedDatabaseHost() error {
	host := strings.ToLower(strings.TrimSpace(os.Getenv("DATABASE_HOST")))
	if _, ok := allowedDatabaseHosts[host]; !ok {
		return errors.New("DATABASE_HOST is not on the staging allowlist")
	}
	return nil
}

// requireBackgroundConsumersOff stops this process from running the shared
// Upstash queues and schedules. REDIS_KEY_PREFIX is not applied: the Redis
// client has no key prefix, and queue names are fixed literals.
func requireBackgroundConsumersOff() error {
	if strings.TrimSpace(os.Getenv("SUB2API_BACKGROUND_CONSUMERS")) != "off" {
		return errors.New("cloudflare profile requires SUB2API_BACKGROUND_CONSUMERS=off")
	}
	return nil
}

// RedisKeyPrefixApplied is false. Setting REDIS_KEY_PREFIX does not change keys.
func RedisKeyPrefixApplied() bool {
	return false
}

func nonTestWriterPermit(permit string) bool {
	permit = strings.TrimSpace(permit)
	if len(permit) < 16 {
		return false
	}
	switch strings.ToLower(permit) {
	case "isolated", "test", "approved", "true", "yes", "1", "production", "staging":
		return false
	default:
		return true
	}
}

// WriterLease is held by this process only. Losing it refuses new HTTP work,
// but Release happens only after background writers stop and the process drains.
type WriterLease struct {
	held     bool
	lost     bool
	released bool
}

// HoldIsolatedLease records the permit. Call it before migrations and before
// background services start.
func HoldIsolatedLease() (*WriterLease, error) {
	if err := RequireIsolatedWriterPermit(); err != nil {
		return nil, err
	}
	return &WriterLease{held: true}, nil
}

func (l *WriterLease) Held() bool {
	return l != nil && l.held && !l.lost && !l.released
}

func (l *WriterLease) Released() bool {
	return l != nil && l.released
}

func (l *WriterLease) RefuseHTTP() bool {
	return l == nil || !l.held || l.lost || l.released
}

// StopThenRelease stops background writers and drains before the permit is released.
// An HTTP 503 by itself does not release the lease.
func (l *WriterLease) StopThenRelease(stopBackground, drain func() error) error {
	if l == nil {
		return errors.New("no isolated writer lease")
	}
	l.lost = true
	if stopBackground == nil || drain == nil {
		return errors.New("lease release requires background stop and drain")
	}
	if err := stopBackground(); err != nil {
		return err
	}
	if err := drain(); err != nil {
		return err
	}
	l.held = false
	l.released = true
	return nil
}
