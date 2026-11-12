package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/viper"
)

// CloudflareProfileEnabled reports the phase-1 Cloudflare Containers profile.
// The Worker sets SUB2API_RUNTIME=cloudflare. Other deployments stay unchanged.
func CloudflareProfileEnabled() bool {
	return strings.EqualFold(strings.TrimSpace(os.Getenv("SUB2API_RUNTIME")), "cloudflare")
}

// ResolveCloudflareConfigPath is the only config file Load is allowed to use
// on this profile. CONFIG_FILE and DATA_DIR/config.yaml must name that file.
func ResolveCloudflareConfigPath() (string, error) {
	configFile := strings.TrimSpace(os.Getenv("CONFIG_FILE"))
	dataDir := strings.TrimSpace(os.Getenv("DATA_DIR"))
	switch {
	case configFile != "" && dataDir != "":
		fromFile := filepath.Clean(configFile)
		fromData := filepath.Clean(filepath.Join(dataDir, "config.yaml"))
		if fromFile != fromData {
			return "", fmt.Errorf("CONFIG_FILE and DATA_DIR/config.yaml resolve to different files")
		}
		return fromFile, nil
	case configFile != "":
		return filepath.Clean(configFile), nil
	case dataDir != "":
		return filepath.Clean(filepath.Join(dataDir, "config.yaml")), nil
	default:
		return "", fmt.Errorf("cloudflare profile requires CONFIG_FILE or DATA_DIR")
	}
}

// InstalledLockFor is the install lock beside the file the process loads.
func InstalledLockFor(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), ".installed")
}

// ConfirmConfigFileUsed checks the file viper actually loaded.
func ConfirmConfigFileUsed(expected string) error {
	used := strings.TrimSpace(viper.ConfigFileUsed())
	if used == "" {
		return fmt.Errorf("process did not load a config file")
	}
	if filepath.Clean(used) != filepath.Clean(expected) {
		return fmt.Errorf("loaded config file does not match the validated path")
	}
	return nil
}
