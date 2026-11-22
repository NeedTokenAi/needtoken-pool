package admin

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/domain"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestOpsHandlerGetMetadata(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	h := &OpsHandler{}
	r.GET("/api/v1/admin/ops/metadata", h.GetMetadata)

	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v1/admin/ops/metadata", nil)
	r.ServeHTTP(w, req)

	require.Equal(t, http.StatusOK, w.Code)

	var resp struct {
		Code int `json:"code"`
		Data struct {
			Platforms         []MetadataPlatformOption         `json:"platforms"`
			SubscriptionTypes []MetadataSubscriptionTypeOption `json:"subscription_types"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &resp))
	require.Equal(t, 0, resp.Code)
	require.Equal(t, len(domain.Platforms())+1, len(resp.Data.Platforms))
	require.Equal(t, domain.PlatformAnthropic, resp.Data.Platforms[0].ID)
	require.Equal(t, domain.PlatformComposite, resp.Data.Platforms[len(resp.Data.Platforms)-1].ID)
	require.True(t, resp.Data.Platforms[len(resp.Data.Platforms)-1].Composite)

	require.Len(t, resp.Data.SubscriptionTypes, 2)
	require.Equal(t, domain.SubscriptionTypeStandard, resp.Data.SubscriptionTypes[0].ID)
	require.Equal(t, domain.SubscriptionTypeSubscription, resp.Data.SubscriptionTypes[1].ID)
}
