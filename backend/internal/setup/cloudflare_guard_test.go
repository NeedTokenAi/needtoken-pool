package setup

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/repository"
	"github.com/spf13/viper"
	"github.com/stretchr/testify/require"
	"gopkg.in/yaml.v3"
)

const cloudflareFixtureTOTPKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func cloudflareJWTFixture() string {
	return strings.Repeat("j", 32)
}

func unsetGuardEnv(t *testing.T, key string) {
	t.Helper()
	previous, ok := os.LookupEnv(key)
	require.NoError(t, os.Unsetenv(key))
	t.Cleanup(func() {
		if ok {
			require.NoError(t, os.Setenv(key, previous))
			return
		}
		require.NoError(t, os.Unsetenv(key))
	})
}

func useCloudflareDataDir(t *testing.T, dir string) {
	t.Helper()
	viper.Reset()
	t.Cleanup(viper.Reset)
	t.Setenv("DATA_DIR", dir)
	unsetGuardEnv(t, "CONFIG_FILE")
	unsetGuardEnv(t, "JWT_SECRET")
	unsetGuardEnv(t, "TOTP_ENCRYPTION_KEY")
	unsetGuardEnv(t, "AUTO_SETUP")
	t.Setenv("SUB2API_RUNTIME", "cloudflare")
	t.Setenv("SKIP_SETUP", "true")
}

func writeInjectedConfig(t *testing.T, dir string) []byte {
	t.Helper()
	body, err := yaml.Marshal(cloudflareConfigFile{
		JWT: struct {
			Secret string `yaml:"secret"`
		}{Secret: cloudflareJWTFixture()},
		Totp: struct {
			EncryptionKey string `yaml:"encryption_key"`
		}{EncryptionKey: cloudflareFixtureTOTPKey},
	})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(dir, ConfigFileName), body, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, InstallLockFile), []byte("installed_at=2020-01-01T00:00:00Z\n"), 0o400))
	return body
}

func TestCloudflareEmptyDiskRefusesAndCreatesNoKey(t *testing.T) {
	dir := t.TempDir()
	useCloudflareDataDir(t, dir)

	err := PrepareProcessStart()
	require.Error(t, err)
	require.Contains(t, err.Error(), "missing original config")

	require.Error(t, AutoSetupFromEnv())
	require.Error(t, Install(&SetupConfig{}))
	require.Error(t, RunCLI())

	entries, readErr := os.ReadDir(dir)
	require.NoError(t, readErr)
	require.Empty(t, entries)

	_, statErr := os.Stat(filepath.Join(dir, ConfigFileName))
	require.True(t, os.IsNotExist(statErr))
	_, statErr = os.Stat(filepath.Join(dir, InstallLockFile))
	require.True(t, os.IsNotExist(statErr))
}

func TestCloudflareInjectedConfigStillDecrypts(t *testing.T) {
	dir := t.TempDir()
	original := writeInjectedConfig(t, dir)
	useCloudflareDataDir(t, dir)

	plaintext := "pool-account-token"
	before, err := repository.NewAESEncryptor(&config.Config{
		Totp: config.TotpConfig{EncryptionKey: cloudflareFixtureTOTPKey},
	})
	require.NoError(t, err)
	ciphertext, err := before.Encrypt(plaintext)
	require.NoError(t, err)

	require.NoError(t, PrepareProcessStart())
	require.False(t, NeedsSetup())
	require.False(t, AutoSetupEnabled())

	cfg, err := config.Load()
	require.NoError(t, err)
	require.Equal(t, cloudflareJWTFixture(), cfg.JWT.Secret)
	require.Equal(t, cloudflareFixtureTOTPKey, cfg.Totp.EncryptionKey)
	require.True(t, cfg.Totp.EncryptionKeyConfigured)

	after, err := repository.NewAESEncryptor(cfg)
	require.NoError(t, err)
	decrypted, err := after.Decrypt(ciphertext)
	require.NoError(t, err)
	require.Equal(t, plaintext, decrypted)

	got, err := os.ReadFile(filepath.Join(dir, ConfigFileName))
	require.NoError(t, err)
	require.Equal(t, original, got)

	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Len(t, entries, 2)
}

func TestCloudflareGuardRejectsIncompleteOriginalFiles(t *testing.T) {
	t.Run("missing lock", func(t *testing.T) {
		dir := t.TempDir()
		useCloudflareDataDir(t, dir)
		body, err := yaml.Marshal(cloudflareConfigFile{
			JWT: struct {
				Secret string `yaml:"secret"`
			}{Secret: cloudflareJWTFixture()},
			Totp: struct {
				EncryptionKey string `yaml:"encryption_key"`
			}{EncryptionKey: cloudflareFixtureTOTPKey},
		})
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(dir, ConfigFileName), body, 0o600))

		err = PrepareProcessStart()
		require.Error(t, err)
		require.Contains(t, err.Error(), "missing install lock")
		entries, readErr := os.ReadDir(dir)
		require.NoError(t, readErr)
		require.Len(t, entries, 1)
	})

	t.Run("missing totp key", func(t *testing.T) {
		dir := t.TempDir()
		useCloudflareDataDir(t, dir)
		body, err := yaml.Marshal(cloudflareConfigFile{
			JWT: struct {
				Secret string `yaml:"secret"`
			}{Secret: cloudflareJWTFixture()},
		})
		require.NoError(t, err)
		require.NoError(t, os.WriteFile(filepath.Join(dir, ConfigFileName), body, 0o600))
		require.NoError(t, os.WriteFile(filepath.Join(dir, InstallLockFile), []byte("installed\n"), 0o400))

		err = PrepareProcessStart()
		require.Error(t, err)
		require.Contains(t, err.Error(), "totp.encryption_key")
	})

	t.Run("env secret differs", func(t *testing.T) {
		dir := t.TempDir()
		writeInjectedConfig(t, dir)
		useCloudflareDataDir(t, dir)
		t.Setenv("JWT_SECRET", strings.Repeat("x", 32))

		err := PrepareProcessStart()
		require.Error(t, err)
		require.Contains(t, err.Error(), "JWT_SECRET")
		require.NotContains(t, err.Error(), strings.Repeat("x", 32))
	})

	t.Run("auto setup on", func(t *testing.T) {
		dir := t.TempDir()
		writeInjectedConfig(t, dir)
		useCloudflareDataDir(t, dir)
		t.Setenv("AUTO_SETUP", "true")

		err := PrepareProcessStart()
		require.Error(t, err)
		require.Contains(t, err.Error(), "AUTO_SETUP")
		require.Error(t, AutoSetupFromEnv())
	})

	t.Run("skip setup off", func(t *testing.T) {
		dir := t.TempDir()
		writeInjectedConfig(t, dir)
		useCloudflareDataDir(t, dir)
		t.Setenv("SKIP_SETUP", "false")

		err := PrepareProcessStart()
		require.Error(t, err)
		require.Contains(t, err.Error(), "SKIP_SETUP")
	})
}

func TestCloudflareProfileUnsetDoesNotTouchDisk(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("DATA_DIR", dir)
	unsetGuardEnv(t, "SUB2API_RUNTIME")
	unsetGuardEnv(t, "AUTO_SETUP")
	t.Setenv("SKIP_SETUP", "")

	require.NoError(t, PrepareProcessStart())
	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Empty(t, entries)
}
