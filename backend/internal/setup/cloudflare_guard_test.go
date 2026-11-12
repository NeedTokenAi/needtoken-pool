package setup

import (
	"errors"
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
	t.Setenv("SUB2API_ISOLATION", "isolated")
	t.Setenv("SUB2API_WRITER_PERMIT", "pool-writer-permit-fixture")
	t.Setenv("DATABASE_HOST", "ep-aged-sunset-b33os2qw.c-4.ap-southeast-1.aws.neon.tech")
	t.Setenv("REDIS_HOST", "existing-upstash.example")
	t.Setenv("SUB2API_BACKGROUND_CONSUMERS", "off")
	t.Setenv("REDIS_KEY_PREFIX", "staging:")
	unsetGuardEnv(t, "STAGING_TEST_JWT_SECRET")
	unsetGuardEnv(t, "STAGING_TEST_TOTP_ENCRYPTION_KEY")
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

func TestCloudflareStagingTestConfigStartsWithoutProductionSecrets(t *testing.T) {
	dir := t.TempDir()
	useCloudflareDataDir(t, dir)
	configPath := filepath.Join(dir, ConfigFileName)
	t.Setenv("CONFIG_FILE", configPath)
	t.Setenv("STAGING_TEST_JWT_SECRET", "staging-test-jwt-secret-not-production")
	t.Setenv("STAGING_TEST_TOTP_ENCRYPTION_KEY", cloudflareFixtureTOTPKey)

	require.NoError(t, PrepareProcessStart())

	body, err := os.ReadFile(configPath)
	require.NoError(t, err)
	require.Contains(t, string(body), "staging-test-jwt-secret-not-production")
	require.Contains(t, string(body), cloudflareFixtureTOTPKey)
	require.NotContains(t, string(body), "JWT_SECRET")
	lock, err := os.ReadFile(filepath.Join(dir, InstallLockFile))
	require.NoError(t, err)
	require.Equal(t, "installed\n", string(lock))

	t.Setenv("JWT_SECRET", "production-jwt-secret-value-32ch")
	err = PrepareProcessStart()
	require.Error(t, err)
	require.Contains(t, err.Error(), "JWT_SECRET")
	got, err := os.ReadFile(configPath)
	require.NoError(t, err)
	require.Equal(t, body, got)
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
	expected, err := config.ResolveCloudflareConfigPath()
	require.NoError(t, err)
	require.NoError(t, config.ConfirmConfigFileUsed(expected))
	require.Equal(t, filepath.Join(dir, ConfigFileName), expected)
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

func TestCloudflareConfigPathsMustBeTheLoadedFile(t *testing.T) {
	dataDir := t.TempDir()
	otherDir := t.TempDir()
	original := writeInjectedConfig(t, dataDir)
	otherKey := strings.Repeat("ab", 31) + "cd"
	otherBody, err := yaml.Marshal(cloudflareConfigFile{
		JWT: struct {
			Secret string `yaml:"secret"`
		}{Secret: cloudflareJWTFixture()},
		Totp: struct {
			EncryptionKey string `yaml:"encryption_key"`
		}{EncryptionKey: otherKey},
	})
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(filepath.Join(otherDir, ConfigFileName), otherBody, 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(otherDir, InstallLockFile), []byte("installed\n"), 0o400))

	useCloudflareDataDir(t, dataDir)
	t.Setenv("CONFIG_FILE", filepath.Join(otherDir, ConfigFileName))

	called := false
	err = BeginProcessWork(func() error {
		called = true
		return nil
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "different files")
	require.False(t, called)

	got, err := os.ReadFile(filepath.Join(dataDir, ConfigFileName))
	require.NoError(t, err)
	require.Equal(t, original, got)
	otherGot, err := os.ReadFile(filepath.Join(otherDir, ConfigFileName))
	require.NoError(t, err)
	require.Contains(t, string(otherGot), otherKey)
}

func TestCloudflarePermitGatesWorkAndRelease(t *testing.T) {
	dir := t.TempDir()
	writeInjectedConfig(t, dir)
	useCloudflareDataDir(t, dir)
	t.Setenv("SUB2API_WRITER_PERMIT", "production")

	called := false
	err := BeginProcessWork(func() error {
		called = true
		return nil
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "non-test writer permit")
	require.False(t, called)

	t.Setenv("SUB2API_WRITER_PERMIT", "isolated")
	err = BeginProcessWork(func() error {
		called = true
		return nil
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "non-test writer permit")
	require.False(t, called)

	t.Setenv("SUB2API_WRITER_PERMIT", "pool-writer-permit-fixture")
	t.Setenv("SUB2API_ISOLATION", "")
	err = BeginProcessWork(func() error {
		called = true
		return nil
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "SUB2API_ISOLATION=isolated")
	require.False(t, called)

	t.Setenv("SUB2API_ISOLATION", "isolated")
	require.NoError(t, BeginProcessWork(func() error { return nil }))

	lease, err := HoldIsolatedLease()
	require.NoError(t, err)
	require.True(t, lease.Held())
	require.False(t, lease.RefuseHTTP())

	err = lease.StopThenRelease(nil, nil)
	require.Error(t, err)
	require.False(t, lease.Released())
	require.True(t, lease.RefuseHTTP())

	order := []string{}
	err = lease.StopThenRelease(
		func() error {
			order = append(order, "stop")
			return errors.New("stop failed")
		},
		func() error {
			order = append(order, "drain")
			return nil
		},
	)
	require.Error(t, err)
	require.Equal(t, []string{"stop"}, order)
	require.False(t, lease.Released())

	err = lease.StopThenRelease(
		func() error {
			order = append(order, "stop")
			return nil
		},
		func() error {
			order = append(order, "drain")
			return nil
		},
	)
	require.NoError(t, err)
	require.Equal(t, []string{"stop", "stop", "drain"}, order)
	require.True(t, lease.Released())
	require.False(t, lease.Held())
	require.True(t, lease.RefuseHTTP())
}

func TestCloudflareStagingDatabaseHostAllowlist(t *testing.T) {
	dir := t.TempDir()
	writeInjectedConfig(t, dir)
	useCloudflareDataDir(t, dir)

	for _, host := range []string{
		"other-db.example",
		"ep-aged-sunset-b33os2qw.c-4.ap-southeast-1.aws.neon.tech-isolated",
		"ep-aged-sunset-b33os2qw.c-4.ap-southeast-1.aws.neon.techisolated",
		"ep-aged-sunset-b33os2qw-pooler.c-4.ap-southeast-1.aws.neon.tech-isolated",
	} {
		t.Run(host, func(t *testing.T) {
			t.Setenv("DATABASE_HOST", host)
			called := false
			err := BeginProcessWork(func() error {
				called = true
				return nil
			})
			require.Error(t, err)
			require.Contains(t, err.Error(), "DATABASE_HOST")
			require.False(t, called)
		})
	}

	for _, host := range []string{
		"ep-aged-sunset-b33os2qw.c-4.ap-southeast-1.aws.neon.tech",
		"ep-aged-sunset-b33os2qw-pooler.c-4.ap-southeast-1.aws.neon.tech",
	} {
		t.Run(host, func(t *testing.T) {
			t.Setenv("DATABASE_HOST", host)
			t.Setenv("REDIS_HOST", "shared-upstash.example")
			called := false
			err := BeginProcessWork(func() error {
				called = true
				return nil
			})
			require.NoError(t, err)
			require.True(t, called)
			require.True(t, RedisKeyPrefixApplied())
		})
	}

	t.Setenv("SUB2API_BACKGROUND_CONSUMERS", "")
	called := false
	err := BeginProcessWork(func() error {
		called = true
		return nil
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "SUB2API_BACKGROUND_CONSUMERS")
	require.False(t, called)
}
