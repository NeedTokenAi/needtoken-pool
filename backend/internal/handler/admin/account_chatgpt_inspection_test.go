//go:build unit

package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type chatGPTInspectionHandlerStub struct {
	service.AdminService
	lookupCalls  int
	inspectCalls int
	err          error
	t            *testing.T
	mutate       func(*service.ChatGPTInspectionReport)
}

func (s *chatGPTInspectionHandlerStub) GetAccount(_ context.Context, id int64) (*service.Account, error) {
	s.lookupCalls++
	a := &service.Account{ID: id, Platform: service.PlatformOpenAI, Type: service.AccountTypeOAuth, GroupIDs: []int64{4}, Credentials: map[string]any{"access_token": "NEVER_RETURN_TOKEN", "refresh_token": "NEVER_RETURN_REFRESH"}, Extra: map[string]any{"private": "NEVER_RETURN_EXTRA"}}
	switch id {
	case 2:
		a.GroupIDs = []int64{9}
	case 3:
		a.Type = service.AccountTypeAPIKey
	case 4:
		a.Platform = service.PlatformAnthropic
	case 5:
		return nil, errors.New("NEVER_RETURN_ERROR")
	}
	return a, nil
}

func (s *chatGPTInspectionHandlerStub) InspectChatGPTAccount(_ context.Context, id int64, request service.ChatGPTInspectionRequest) (*service.ChatGPTInspectionReport, error) {
	s.inspectCalls++
	require.Equal(s.t, int64(1), id)
	require.Equal(s.t, int64(42), request.ExpectedProxyID)
	require.Equal(s.t, "owned-chatgpt-account", request.ExpectedChatGPTAccountID)
	if s.err != nil {
		return nil, s.err
	}
	var report service.ChatGPTInspectionReport
	require.NoError(s.t, json.Unmarshal([]byte(`{"campaign":"chatgpt-plus-us-mvp0","native_account_id":1,"status":"blocked","code":"apple_transaction_ownership_unverified","read_only":true,"purchase_attempted":false,"transaction_ownership_verified":false,"mvp0_passed":false,"sales_enabled":false,"configured_proxy_id":42,"proxy_pin_verified":true,"actual_egress_ip_verified":false,"observation":{"account_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","plan":"plus","expires_at":"2026-12-05T12:00:00Z","observed_at":"2026-11-05T12:00:00Z","evidence_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}`), &report))
	if s.mutate != nil {
		s.mutate(&report)
	}
	return &report, nil
}

func TestChatGPTInspectionHandlerRejectsWrongScopeAndSuccessClaims(t *testing.T) {
	for _, mutate := range []func(*service.ChatGPTInspectionReport){
		func(r *service.ChatGPTInspectionReport) { r.NativeAccountID = 9 },
		func(r *service.ChatGPTInspectionReport) { r.ConfiguredProxyID = 9 },
		func(r *service.ChatGPTInspectionReport) { r.Campaign = "another-campaign" },
		func(r *service.ChatGPTInspectionReport) { r.Status = "passed" },
		func(r *service.ChatGPTInspectionReport) { r.Code = "passed" },
		func(r *service.ChatGPTInspectionReport) { r.ReadOnly = false },
		func(r *service.ChatGPTInspectionReport) { r.ProxyPinVerified = false },
		func(r *service.ChatGPTInspectionReport) { r.ActualEgressIPVerified = true },
		func(r *service.ChatGPTInspectionReport) { r.PurchaseAttempted = true },
		func(r *service.ChatGPTInspectionReport) { r.TransactionOwnershipVerified = true },
		func(r *service.ChatGPTInspectionReport) { r.MVP0Passed = true },
		func(r *service.ChatGPTInspectionReport) { r.SalesEnabled = true },
	} {
		s := &chatGPTInspectionHandlerStub{t: t, mutate: mutate}
		w := httptest.NewRecorder()
		newChatGPTInspectionHandlerRouter(s, nil).ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts/1/chatgpt-inspection", strings.NewReader(chatGPTInspectionTestBody)))
		require.Equal(t, 502, w.Code, w.Body.String())
		require.Contains(t, w.Body.String(), "CHATGPT_INSPECTION_RESPONSE_UNVERIFIED")
		require.NotContains(t, w.Body.String(), "observation")
	}
}

func newChatGPTInspectionHandlerRouter(s *chatGPTInspectionHandlerStub, policy *adminaccess.Policy) *gin.Engine {
	gin.SetMode(gin.TestMode)
	h := &AccountHandler{adminService: s}
	r := gin.New()
	if policy != nil {
		r.Use(func(c *gin.Context) {
			c.Request = c.Request.WithContext(adminaccess.WithPrincipal(c.Request.Context(), &adminaccess.Principal{Policy: *policy}))
		})
	}
	r.Use(h.ScopedAdminKeyAccounts)
	r.POST("/api/v1/admin/accounts/:id/chatgpt-inspection", h.InspectChatGPTAccount)
	return r
}

func chatGPTInspectionTestPolicy(permission string) adminaccess.Policy {
	return adminaccess.Policy{Rules: []adminaccess.Rule{{Permissions: []string{permission}, GroupIDs: []int64{4}, AccountTypes: []string{service.AccountTypeOAuth}, Platforms: []string{service.PlatformOpenAI}}}}
}

const chatGPTInspectionTestBody = `{"expected_proxy_id":42,"expected_chatgpt_account_id":"owned-chatgpt-account"}`

func TestChatGPTInspectionHandlerExplicitScopeAndAccountLimits(t *testing.T) {
	for _, tc := range []struct {
		name    string
		policy  adminaccess.Policy
		account string
		want    int
		calls   int
	}{
		{"explicit scope", chatGPTInspectionTestPolicy(chatGPTInspectionPermission), "1", 200, 1},
		{"account read is insufficient", chatGPTInspectionTestPolicy("accounts.read"), "1", 403, 0},
		{"ops read is insufficient", adminaccess.Policy{GlobalPermissions: []string{"ops.read"}}, "1", 403, 0},
		{"wrong group", chatGPTInspectionTestPolicy(chatGPTInspectionPermission), "2", 404, 0},
		{"wrong type", chatGPTInspectionTestPolicy(chatGPTInspectionPermission), "3", 404, 0},
		{"wrong platform", chatGPTInspectionTestPolicy(chatGPTInspectionPermission), "4", 404, 0},
		{"lookup failure", chatGPTInspectionTestPolicy(chatGPTInspectionPermission), "5", 404, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := &chatGPTInspectionHandlerStub{t: t}
			r := newChatGPTInspectionHandlerRouter(s, &tc.policy)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts/"+tc.account+"/chatgpt-inspection", strings.NewReader(chatGPTInspectionTestBody)))
			require.Equal(t, tc.want, w.Code, w.Body.String())
			require.Equal(t, tc.calls, s.inspectCalls)
			require.NotContains(t, w.Body.String(), "NEVER_RETURN")
			require.NotContains(t, w.Body.String(), "access_token")
			require.NotContains(t, w.Body.String(), "refresh_token")
			require.NotContains(t, w.Body.String(), "owned-chatgpt-account")
			if tc.want == 200 {
				require.Contains(t, w.Body.String(), `"status":"blocked"`)
				require.Contains(t, w.Body.String(), `"proxy_pin_verified":true`)
				require.Contains(t, w.Body.String(), `"actual_egress_ip_verified":false`)
				require.Contains(t, w.Body.String(), `"mvp0_passed":false`)
				require.Equal(t, "no-store", w.Header().Get("Cache-Control"))
			}
		})
	}
}

func TestChatGPTInspectionHandlerKeepsOrdinaryAdminPath(t *testing.T) {
	s := &chatGPTInspectionHandlerStub{t: t}
	w := httptest.NewRecorder()
	newChatGPTInspectionHandlerRouter(s, nil).ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts/1/chatgpt-inspection", strings.NewReader(chatGPTInspectionTestBody)))
	require.Equal(t, 200, w.Code, w.Body.String())
	require.Equal(t, 1, s.inspectCalls)
}

func TestChatGPTInspectionHandlerRejectsCredentialInjectionAndAmbiguousJSON(t *testing.T) {
	for _, body := range []string{
		`{}`, `null`, `[]`,
		`{"expected_proxy_id":42,"expected_chatgpt_account_id":"owned-chatgpt-account","token":"NEVER_RETURN_TOKEN"}`,
		`{"expected_proxy_id":42,"expected_chatgpt_account_id":"owned-chatgpt-account","proxy_url":"https://NEVER_RETURN_PASSWORD@outside.test"}`,
		`{"expected_proxy_id":42,"expected_proxy_id":43,"expected_chatgpt_account_id":"owned-chatgpt-account"}`,
		chatGPTInspectionTestBody + ` {"ignored":"NEVER_RETURN_TOKEN"}`,
		`{"expected_proxy_id":0,"expected_chatgpt_account_id":"owned-chatgpt-account"}`,
		`{"expected_proxy_id":42,"expected_chatgpt_account_id":null}`,
		strings.Repeat("x", 4097),
	} {
		s := &chatGPTInspectionHandlerStub{t: t}
		w := httptest.NewRecorder()
		newChatGPTInspectionHandlerRouter(s, nil).ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts/1/chatgpt-inspection", strings.NewReader(body)))
		require.Equal(t, 400, w.Code, w.Body.String())
		require.Zero(t, s.inspectCalls)
		require.NotContains(t, w.Body.String(), "NEVER_RETURN")
	}
}

func TestChatGPTInspectionHandlerControlsErrorReasonsAndNeverEchoesCause(t *testing.T) {
	for _, tc := range []struct {
		reason string
		status int
	}{
		{"CHATGPT_INSPECTION_DISABLED", 503},
		{"CHATGPT_INSPECTION_INVALID", 400},
		{"CHATGPT_INSPECTION_ACCOUNT_NOT_FOUND", 404},
		{"CHATGPT_INSPECTION_PIN_MISMATCH", 409},
		{"CHATGPT_INSPECTION_IDENTITY_CHANGED", 409},
		{"CHATGPT_INSPECTION_CREDENTIAL_REJECTED", 502},
		{"CHATGPT_INSPECTION_INTERACTION_REQUIRED", 502},
		{"CHATGPT_INSPECTION_RESPONSE_UNVERIFIED", 502},
		{"CHATGPT_INSPECTION_UPSTREAM_UNAVAILABLE", 502},
		{"NEVER_RETURN_REASON", 502},
	} {
		s := &chatGPTInspectionHandlerStub{t: t, err: infraerrors.New(500, tc.reason, "NEVER_RETURN_MESSAGE").WithMetadata(map[string]string{"token": "NEVER_RETURN_TOKEN"}).WithCause(errors.New("NEVER_RETURN_CAUSE"))}
		w := httptest.NewRecorder()
		newChatGPTInspectionHandlerRouter(s, nil).ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts/1/chatgpt-inspection", strings.NewReader(chatGPTInspectionTestBody)))
		require.Equal(t, tc.status, w.Code, w.Body.String())
		require.NotContains(t, w.Body.String(), "NEVER_RETURN")
		require.NotContains(t, w.Body.String(), "metadata")
		require.NotContains(t, w.Body.String(), "observation")
	}
}
