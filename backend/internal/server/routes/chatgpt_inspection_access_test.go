//go:build unit

package routes

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/handler"
	adminhandler "github.com/Wei-Shaw/sub2api/internal/handler/admin"
	"github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type chatGPTInspectionRouteAccounts struct {
	scopedRouteAccounts
	calls int
}

func (s *chatGPTInspectionRouteAccounts) InspectChatGPTAccount(_ context.Context, id int64, input service.ChatGPTInspectionRequest) (*service.ChatGPTInspectionReport, error) {
	s.calls++
	var report service.ChatGPTInspectionReport
	err := json.Unmarshal([]byte(`{"campaign":"chatgpt-plus-us-mvp0","native_account_id":1,"status":"blocked","code":"apple_transaction_ownership_unverified","read_only":true,"purchase_attempted":false,"transaction_ownership_verified":false,"mvp0_passed":false,"sales_enabled":false,"configured_proxy_id":42,"proxy_pin_verified":true,"actual_egress_ip_verified":false,"observation":{"account_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","plan":"plus","observed_at":"2026-11-05T12:00:00Z","evidence_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}`), &report)
	return &report, err
}

func TestRegisteredChatGPTInspectionRequiresExplicitKeyAndResourceScope(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name, permission, account string
		want                      int
	}{
		{"explicit", "accounts.subscription.inspect", "1", 200},
		{"accounts read", "accounts.read", "1", 403},
		{"global ops read", "ops.read", "1", 403},
		{"foreign group", "accounts.subscription.inspect", "3", 404},
		{"foreign type", "accounts.subscription.inspect", "2", 404},
		{"foreign platform", "accounts.subscription.inspect", "4", 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			policy := adminaccess.Policy{Rules: []adminaccess.Rule{{Permissions: []string{tc.permission}, GroupIDs: []int64{1}, AccountTypes: []string{"oauth"}, Platforms: []string{"openai"}}}}
			if tc.permission == "ops.read" {
				policy = adminaccess.Policy{GlobalPermissions: []string{"ops.read"}}
			}
			keys := &scopedRouteKeys{}
			settings := service.NewSettingService(nil, nil)
			settings.SetScopedAdminKeyRepository(keys)
			key, _, err := settings.CreateScopedAdminKey(context.Background(), service.ScopedAdminKeyInput{Name: "inspection only", Enabled: true, Policy: policy}, 9)
			require.NoError(t, err)
			users := service.NewUserService(&scopedRouteUsers{}, nil, nil, nil)
			auth := middleware.NewAdminAuthMiddleware(nil, users, settings, nil)
			accounts := &chatGPTInspectionRouteAccounts{scopedRouteAccounts: scopedRouteAccounts{t: t}}
			h := adminhandler.NewAccountHandler(accounts, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil)
			r := gin.New()
			RegisterAdminRoutes(r.Group("/api/v1"), &handler.Handlers{Admin: &handler.AdminHandlers{Account: h, Setting: adminhandler.NewSettingHandler(settings, nil, nil, nil, nil, nil, nil)}}, auth, middleware.AuditLogMiddleware(func(c *gin.Context) { c.Next() }), middleware.StepUpAuthMiddleware(func(c *gin.Context) { c.Next() }), nil, nil)
			req := httptest.NewRequest(http.MethodPost, "/api/v1/admin/accounts/"+tc.account+"/chatgpt-inspection", strings.NewReader(`{"expected_proxy_id":42,"expected_chatgpt_account_id":"owned-chatgpt-account"}`))
			req.Header.Set("x-api-key", key)
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			require.Equal(t, tc.want, w.Code, w.Body.String())
			wantCalls := 0
			if tc.want == 200 {
				wantCalls = 1
			}
			require.Equal(t, wantCalls, accounts.calls)
			require.NotContains(t, w.Body.String(), "绝不返回")
			require.NotContains(t, w.Body.String(), "access_token")
		})
	}
}
