//go:build unit

package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestChatGPTInspectionPolicyCanLoadFromExplicitEnvironmentName(t *testing.T) {
	resetViperWithJWTSecret(t)
	const policy = `[{"account_id":11,"proxy_id":42,"chatgpt_account_id":"owned-target"}]`
	t.Setenv("SUB2API_CHATGPT_INSPECTION_POLICIES", policy)
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, policy, cfg.ChatGPTInspectionPolicies)
}

func TestChatGPTInspectionPolicyIsDisabledByDefault(t *testing.T) {
	resetViperWithJWTSecret(t)
	t.Setenv("SUB2API_CHATGPT_INSPECTION_POLICIES", "")
	cfg, err := Load()
	require.NoError(t, err)
	require.Empty(t, cfg.ChatGPTInspectionPolicies)
}
