package config

import (
	"os"
	"strings"
)

// CloudflareProfileEnabled reports the phase-1 Cloudflare Containers profile.
// The Worker sets SUB2API_RUNTIME=cloudflare. Other deployments stay unchanged.
func CloudflareProfileEnabled() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("SUB2API_RUNTIME")), "cloudflare")
}
