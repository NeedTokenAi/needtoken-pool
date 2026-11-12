package setup

import (
	"errors"
	"fmt"
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
	if err := requireExactHost("DATABASE_HOST", "POOL_ISOLATED_DATABASE_HOSTS"); err != nil {
		return err
	}
	return requireExactHost("REDIS_HOST", "POOL_ISOLATED_REDIS_HOSTS")
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

func requireExactHost(hostEnv, allowEnv string) error {
	host := strings.ToLower(strings.TrimSpace(os.Getenv(hostEnv)))
	raw := strings.TrimSpace(os.Getenv(allowEnv))
	if host == "" || raw == "" || strings.HasPrefix(raw, "{") || strings.HasPrefix(raw, "[") {
		return fmt.Errorf("%s is not on the isolated allowlist", hostEnv)
	}
	for item := range strings.SplitSeq(raw, ",") {
		if strings.ToLower(strings.TrimSpace(item)) == host {
			return nil
		}
	}
	return fmt.Errorf("%s is not on the isolated allowlist", hostEnv)
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
