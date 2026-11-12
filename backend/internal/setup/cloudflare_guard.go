package setup

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"gopkg.in/yaml.v3"
)

type cloudflareConfigFile struct {
	JWT struct {
		Secret string `yaml:"secret"`
	} `yaml:"jwt"`
	Totp struct {
		EncryptionKey string `yaml:"encryption_key"`
	} `yaml:"totp"`
}

// PrepareProcessStart is the first check in main. On the Cloudflare profile it
// returns before setup, config loading, and database bootstrap, so none of
// those paths can mint a JWT, TOTP, or secret-encryption key. Other runtimes
// are unchanged.
func PrepareProcessStart() error {
	if !config.CloudflareProfileEnabled() {
		return nil
	}
	if err := MaterializeStagingTestConfig(); err != nil {
		return err
	}
	if err := GuardCloudflareStartup(); err != nil {
		return err
	}
	if err := RequireIsolatedWriterPermit(); err != nil {
		return err
	}
	if NeedsSetup() || AutoSetupEnabled() {
		return fmt.Errorf("cloudflare profile refuses to enter setup")
	}
	return nil
}

// BeginProcessWork runs setup, migrations, or background start only after the
// Cloudflare guard and the isolated writer permit both succeed. The permit is
// local to this process. The existing production process does not read it.
func BeginProcessWork(work func() error) error {
	if err := PrepareProcessStart(); err != nil {
		return err
	}
	if work == nil {
		return nil
	}
	return work()
}

// GuardCloudflareStartup requires the original config file and install lock.
// It reads them and returns. It does not create files and does not generate secrets.
func GuardCloudflareStartup() error {
	if !config.CloudflareProfileEnabled() {
		return nil
	}
	if !skipSetupEnabled() {
		return errors.New("cloudflare profile requires SKIP_SETUP=true")
	}
	if AutoSetupEnabled() {
		return errors.New("cloudflare profile requires AUTO_SETUP off")
	}

	configPath, err := config.ResolveCloudflareConfigPath()
	if err != nil {
		return err
	}
	lockPath := config.InstalledLockFor(configPath)
	configBytes, err := os.ReadFile(configPath)
	if err != nil || len(bytes.TrimSpace(configBytes)) == 0 {
		return fmt.Errorf("cloudflare profile missing original config %s", configPath)
	}
	lockInfo, err := os.Stat(lockPath)
	if err != nil || lockInfo.IsDir() {
		return fmt.Errorf("cloudflare profile missing install lock %s", lockPath)
	}

	var parsed cloudflareConfigFile
	if err := yaml.Unmarshal(configBytes, &parsed); err != nil {
		return fmt.Errorf("cloudflare profile cannot read original config: %w", err)
	}
	jwtSecret := strings.TrimSpace(parsed.JWT.Secret)
	totpKey := strings.TrimSpace(parsed.Totp.EncryptionKey)
	if jwtSecret == "" {
		return errors.New("cloudflare profile refuses to start without the original jwt.secret")
	}
	if totpKey == "" {
		return errors.New("cloudflare profile refuses to start without the original totp.encryption_key")
	}
	if err := sameSecretOrUnset("JWT_SECRET", jwtSecret); err != nil {
		return err
	}
	if err := sameSecretOrUnset("TOTP_ENCRYPTION_KEY", totpKey); err != nil {
		return err
	}
	return nil
}

// MaterializeStagingTestConfig writes config.yaml and .installed from the
// test-only STAGING_TEST_JWT_SECRET and STAGING_TEST_TOTP_ENCRYPTION_KEY
// variables. It does not read JWT_SECRET or TOTP_ENCRYPTION_KEY, and it does
// not generate a key when those test variables are absent.
func MaterializeStagingTestConfig() error {
	if !config.CloudflareProfileEnabled() {
		return nil
	}
	_, jwtSet := os.LookupEnv("STAGING_TEST_JWT_SECRET")
	_, totpSet := os.LookupEnv("STAGING_TEST_TOTP_ENCRYPTION_KEY")
	if !jwtSet && !totpSet {
		return nil
	}
	jwtSecret := strings.TrimSpace(os.Getenv("STAGING_TEST_JWT_SECRET"))
	totpKey := strings.TrimSpace(os.Getenv("STAGING_TEST_TOTP_ENCRYPTION_KEY"))
	if jwtSecret == "" || totpKey == "" {
		return errors.New("staging test config requires both STAGING_TEST_JWT_SECRET and STAGING_TEST_TOTP_ENCRYPTION_KEY")
	}
	if len(jwtSecret) < 32 {
		return errors.New("staging test JWT must be at least 32 characters")
	}
	if !stagingTestTOTPKeyOK(totpKey) {
		return errors.New("staging test TOTP key must be 64 hex characters")
	}
	if strings.TrimSpace(os.Getenv("JWT_SECRET")) != "" || strings.TrimSpace(os.Getenv("TOTP_ENCRYPTION_KEY")) != "" {
		return errors.New("staging test config refuses JWT_SECRET and TOTP_ENCRYPTION_KEY")
	}
	if strings.TrimSpace(os.Getenv("CONFIG_FILE")) == "" || strings.TrimSpace(os.Getenv("DATA_DIR")) == "" {
		return errors.New("staging test config requires CONFIG_FILE and DATA_DIR")
	}
	if AutoSetupEnabled() {
		return errors.New("staging test config requires AUTO_SETUP off")
	}
	configPath, err := config.ResolveCloudflareConfigPath()
	if err != nil {
		return err
	}
	var parsed cloudflareConfigFile
	parsed.JWT.Secret = jwtSecret
	parsed.Totp.EncryptionKey = totpKey
	body, err := yaml.Marshal(parsed)
	if err != nil {
		return err
	}
	if existing, readErr := os.ReadFile(configPath); readErr == nil {
		if !bytes.Equal(bytes.TrimSpace(existing), bytes.TrimSpace(body)) {
			return errors.New("staging test config refuses to replace a different config.yaml")
		}
	} else if !os.IsNotExist(readErr) {
		return readErr
	} else {
		if err := os.MkdirAll(filepath.Dir(configPath), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(configPath, body, 0o600); err != nil {
			return err
		}
	}
	lockPath := config.InstalledLockFor(configPath)
	if _, statErr := os.Stat(lockPath); statErr != nil {
		if !os.IsNotExist(statErr) {
			return statErr
		}
		if err := os.WriteFile(lockPath, []byte("installed\n"), 0o400); err != nil {
			return err
		}
	}
	return nil
}

func stagingTestTOTPKeyOK(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f', r >= 'A' && r <= 'F':
		default:
			return false
		}
	}
	return true
}

func sameSecretOrUnset(envName, fileValue string) error {
	envValue, ok := os.LookupEnv(envName)
	if !ok || strings.TrimSpace(envValue) == "" {
		return nil
	}
	if strings.TrimSpace(envValue) != fileValue {
		return fmt.Errorf("cloudflare profile refuses %s that differs from the original config", envName)
	}
	return nil
}
