package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/stretchr/testify/require"
)

type inspectionAccountRepository struct {
	AdminAccountRepository
	account *Account
	reads   int
}

func (r *inspectionAccountRepository) GetByID(context.Context, int64) (*Account, error) {
	r.reads++
	copyAccount := *r.account
	return &copyAccount, nil
}

type inspectionProxyRepository struct {
	ProxyRepository
	proxy *Proxy
	reads int
}

func (r *inspectionProxyRepository) GetByID(context.Context, int64) (*Proxy, error) {
	r.reads++
	copyProxy := *r.proxy
	return &copyProxy, nil
}

type inspectionRoundTripper func(*http.Request) (*http.Response, error)

func (f inspectionRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func inspectionJSONResponse(body string) *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}

func inspectionFixture(t *testing.T) (*adminServiceImpl, *inspectionAccountRepository, *inspectionProxyRepository, *[]string) {
	t.Helper()
	id := int64(42)
	a := &inspectionAccountRepository{account: &Account{ID: 11, Platform: PlatformOpenAI, Type: AccountTypeOAuth, Status: StatusActive, ProxyID: &id,
		Credentials: map[string]any{"access_token": "owned-token-secret"}, GroupIDs: []int64{7}}}
	p := &inspectionProxyRepository{proxy: &Proxy{ID: 42, Protocol: "http", Host: "test-proxy", Port: 8080, Username: "proxy-user", Password: "proxy-password-secret", Status: StatusActive, FallbackMode: FallbackModeNone}}
	policies, err := parseChatGPTInspectionPolicies(&config.Config{ChatGPTInspectionPolicies: `[{"account_id":11,"proxy_id":42,"chatgpt_account_id":"owned-target"}]`})
	require.NoError(t, err)
	paths := []string{}
	s := &adminServiceImpl{accountRepo: a, proxyRepo: p, chatGPTInspectionPolicies: policies}
	s.chatGPTInspectionClient = func(proxyURL string) (*http.Client, error) {
		require.Equal(t, "http://proxy-user:proxy-password-secret@test-proxy:8080", proxyURL)
		return &http.Client{Transport: inspectionRoundTripper(func(r *http.Request) (*http.Response, error) {
			paths = append(paths, r.URL.Path)
			require.Equal(t, http.MethodGet, r.Method)
			require.Equal(t, "https", r.URL.Scheme)
			require.Equal(t, "chatgpt.com", r.URL.Host)
			require.Equal(t, "Bearer owned-token-secret", r.Header.Get("Authorization"))
			require.Empty(t, r.Header.Get("Cookie"))
			switch r.URL.Path {
			case "/backend-api/accounts/check/v4-2023-04-27":
				return inspectionJSONResponse(`{"accounts":{"default":{"account":{"account_id":"owned-target","plan_type":"plus"},"entitlement":{"expires_at":"2027-01-01T00:00:00Z"}}}}`), nil
			case "/backend-api/subscriptions":
				require.Equal(t, "owned-target", r.URL.Query().Get("account_id"))
				return inspectionJSONResponse(`{"plan_type":"plus","active_until":"2027-01-01T00:00:00Z"}`), nil
			default:
				t.Fatal("unexpected upstream method or path")
				return nil, errors.New("unexpected request")
			}
		})}, nil
	}
	return s, a, p, &paths
}

func inspectionRequest() ChatGPTInspectionRequest {
	return ChatGPTInspectionRequest{ExpectedProxyID: 42, ExpectedChatGPTAccountID: "owned-target"}
}

func TestChatGPTInspectionUsesExistingCredentialAndExactProxyWithoutWrites(t *testing.T) {
	s, a, p, paths := inspectionFixture(t)
	beforeAccount, _ := json.Marshal(a.account)
	beforeProxy, _ := json.Marshal(p.proxy)
	report, err := s.InspectChatGPTAccount(context.Background(), 11, inspectionRequest())
	require.NoError(t, err)
	require.Equal(t, []string{"/backend-api/accounts/check/v4-2023-04-27", "/backend-api/subscriptions"}, *paths)
	require.Equal(t, 2, a.reads)
	require.Equal(t, 2, p.reads)
	require.Equal(t, int64(11), report.NativeAccountID)
	require.Equal(t, int64(42), report.ConfiguredProxyID)
	require.True(t, report.ReadOnly)
	require.True(t, report.ProxyPinVerified)
	require.False(t, report.ActualEgressIPVerified)
	require.False(t, report.PurchaseAttempted)
	require.False(t, report.TransactionOwnershipVerified)
	require.False(t, report.MVP0Passed)
	require.False(t, report.SalesEnabled)
	require.Equal(t, "blocked", report.Status)
	require.Equal(t, "plus", report.Observation.Plan)
	require.Len(t, report.Observation.AccountSHA256, 64)
	require.Len(t, report.Observation.EvidenceSHA256, 64)
	encoded, err := json.Marshal(report)
	require.NoError(t, err)
	for _, secret := range []string{"owned-token-secret", "proxy-user", "proxy-password-secret", "test-proxy", "owned-target", "access_token", "credentials"} {
		require.NotContains(t, string(encoded), secret)
	}
	afterAccount, _ := json.Marshal(a.account)
	afterProxy, _ := json.Marshal(p.proxy)
	require.JSONEq(t, string(beforeAccount), string(afterAccount))
	require.JSONEq(t, string(beforeProxy), string(afterProxy))
}

func TestChatGPTInspectionPolicyMustExplicitlyAllowEveryReference(t *testing.T) {
	for _, kind := range []string{"disabled", "invalid-config", "account-not-allowed", "proxy-mismatch", "target-mismatch"} {
		t.Run(kind, func(t *testing.T) {
			s, a, _, paths := inspectionFixture(t)
			req := inspectionRequest()
			id := int64(11)
			switch kind {
			case "disabled":
				s.chatGPTInspectionPolicies = nil
			case "invalid-config":
				s.chatGPTInspectionPolicyInvalid = true
			case "account-not-allowed":
				id = 12
			case "proxy-mismatch":
				req.ExpectedProxyID = 43
			case "target-mismatch":
				req.ExpectedChatGPTAccountID = "another-target"
			}
			report, err := s.InspectChatGPTAccount(context.Background(), id, req)
			require.Error(t, err)
			require.Nil(t, report)
			require.Zero(t, a.reads)
			require.Empty(t, *paths)
		})
	}
}

func TestChatGPTInspectionRejectsUnpinnedOrUnusableProxy(t *testing.T) {
	for _, kind := range []string{"direct", "wrong-proxy", "inactive", "expired", "fallback-direct", "fallback-proxy", "backup", "unknown-protocol", "half-credentials", "shadow", "wrong-platform", "apikey"} {
		t.Run(kind, func(t *testing.T) {
			s, a, p, paths := inspectionFixture(t)
			switch kind {
			case "direct":
				a.account.ProxyID = nil
			case "wrong-proxy":
				id := int64(43)
				a.account.ProxyID = &id
			case "inactive":
				p.proxy.Status = "inactive"
			case "expired":
				past := time.Now().Add(-time.Minute)
				p.proxy.ExpiresAt = &past
			case "fallback-direct":
				p.proxy.FallbackMode = FallbackModeDirect
			case "fallback-proxy":
				p.proxy.FallbackMode = FallbackModeProxy
			case "backup":
				id := int64(99)
				p.proxy.BackupProxyID = &id
			case "unknown-protocol":
				p.proxy.Protocol = "custom"
			case "half-credentials":
				p.proxy.Password = ""
			case "shadow":
				id := int64(12)
				a.account.ParentAccountID = &id
			case "wrong-platform":
				a.account.Platform = "anthropic"
			case "apikey":
				a.account.Type = AccountTypeAPIKey
			}
			report, err := s.InspectChatGPTAccount(context.Background(), 11, inspectionRequest())
			require.Error(t, err)
			require.Nil(t, report)
			require.Empty(t, *paths)
		})
	}
}

func TestChatGPTInspectionRechecksScopedAuthorization(t *testing.T) {
	s, _, _, paths := inspectionFixture(t)
	principal := &adminaccess.Principal{Policy: adminaccess.Policy{Rules: []adminaccess.Rule{{Permissions: []string{ChatGPTInspectionPermission}, GroupIDs: []int64{8}, AccountTypes: []string{AccountTypeOAuth}, Platforms: []string{PlatformOpenAI}}}}}
	ctx := adminaccess.WithPrincipal(context.Background(), principal)
	report, err := s.InspectChatGPTAccount(ctx, 11, inspectionRequest())
	require.ErrorIs(t, err, ErrChatGPTInspectionAccountNotFound)
	require.Nil(t, report)
	require.Empty(t, *paths)
	principal.Policy.Rules[0].GroupIDs = []int64{7}
	report, err = s.InspectChatGPTAccount(ctx, 11, inspectionRequest())
	require.NoError(t, err)
	require.NotNil(t, report)
}

func TestChatGPTInspectionDiscardsObservationAfterNetworkIdentityChanges(t *testing.T) {
	for _, kind := range []string{"binding", "token", "proxy-host", "proxy-auth", "proxy-expired", "scope"} {
		t.Run(kind, func(t *testing.T) {
			s, a, p, _ := inspectionFixture(t)
			factory := s.chatGPTInspectionClient
			s.chatGPTInspectionClient = func(proxyURL string) (*http.Client, error) {
				client, err := factory(proxyURL)
				require.NoError(t, err)
				original := client.Transport
				client.Transport = inspectionRoundTripper(func(r *http.Request) (*http.Response, error) {
					resp, err := original.RoundTrip(r)
					if r.URL.Path == "/backend-api/subscriptions" {
						switch kind {
						case "binding":
							id := int64(43)
							a.account.ProxyID = &id
						case "token":
							a.account.Credentials = map[string]any{"access_token": "new-token"}
						case "proxy-host":
							p.proxy.Host = "changed-proxy"
						case "proxy-auth":
							p.proxy.Password = "changed-password"
						case "proxy-expired":
							past := time.Now().Add(-time.Minute)
							p.proxy.ExpiresAt = &past
						case "scope":
							a.account.GroupIDs = []int64{8}
						}
					}
					return resp, err
				})
				return client, nil
			}
			ctx := context.Background()
			if kind == "scope" {
				ctx = adminaccess.WithPrincipal(ctx, &adminaccess.Principal{Policy: adminaccess.Policy{Rules: []adminaccess.Rule{{Permissions: []string{ChatGPTInspectionPermission}, GroupIDs: []int64{7}, AccountTypes: []string{AccountTypeOAuth}}}}})
			}
			report, err := s.InspectChatGPTAccount(ctx, 11, inspectionRequest())
			require.ErrorIs(t, err, ErrChatGPTInspectionIdentityChanged)
			require.Nil(t, report)
		})
	}
}

func TestChatGPTInspectionUpstreamErrorsNeverExposeTokenOrProxy(t *testing.T) {
	s, _, _, _ := inspectionFixture(t)
	s.chatGPTInspectionClient = func(string) (*http.Client, error) {
		return nil, errors.New("owned-token-secret http://proxy-user:proxy-password-secret@test-proxy")
	}
	report, err := s.InspectChatGPTAccount(context.Background(), 11, inspectionRequest())
	require.Nil(t, report)
	require.ErrorIs(t, err, ErrChatGPTInspectionUpstreamUnavailable)
	require.NotContains(t, err.Error(), "secret")
	require.NotContains(t, infraerrors.Message(err), "proxy-user")
}

func TestChatGPTInspectionStartupPolicyParsingIsBoundedAndStrict(t *testing.T) {
	for _, raw := range []string{`null`, `{}`, `[{"account_id":11,"proxy_id":42,"chatgpt_account_id":"target","token":"secret"}]`, `[{"account_id":11,"account_id":12,"proxy_id":42,"chatgpt_account_id":"target"}]`, `[{"account_id":11,"proxy_id":42,"chatgpt_account_id":"target"},{"account_id":11,"proxy_id":43,"chatgpt_account_id":"other"}]`, `[{"account_id":11,"proxy_id":0,"chatgpt_account_id":"target"}]`, `[] []`, strings.Repeat(" ", 32*1024+1)} {
		policies, err := parseChatGPTInspectionPolicies(&config.Config{ChatGPTInspectionPolicies: raw})
		require.Error(t, err, "invalid startup policy accepted")
		require.Nil(t, policies)
		require.NotContains(t, err.Error(), "secret")
	}
	policies, err := parseChatGPTInspectionPolicies(nil)
	require.NoError(t, err)
	require.Empty(t, policies)
	cfg := &config.Config{ChatGPTInspectionPolicies: `[{"account_id":11,"proxy_id":42,"chatgpt_account_id":"target"}]`}
	policies, err = parseChatGPTInspectionPolicies(cfg)
	require.NoError(t, err)
	cfg.ChatGPTInspectionPolicies = `[]`
	require.Equal(t, int64(42), policies[11].ProxyID, "parsed allowlist must not follow mutable config text")
}
