package admin

import (
	"github.com/Wei-Shaw/sub2api/internal/domain"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/gin-gonic/gin"
)

// MetadataPlatformOption describes a selectable group platform derived from domain.Platforms().
type MetadataPlatformOption struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
	Gateway     string `json:"gateway"`
	CNProvider  bool   `json:"cn_provider,omitempty"`
	Composite   bool   `json:"composite,omitempty"`
}

// MetadataSubscriptionTypeOption describes a selectable group subscription mode.
type MetadataSubscriptionTypeOption struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

// GetMetadata returns dynamic group/account creation metadata (platforms & subscription types).
// GET /api/v1/admin/ops/metadata
func (h *OpsHandler) GetMetadata(c *gin.Context) {
	specs := domain.Platforms()
	platforms := make([]MetadataPlatformOption, 0, len(specs)+1)
	for _, spec := range specs {
		platforms = append(platforms, MetadataPlatformOption{
			ID:          spec.ID,
			DisplayName: spec.DisplayName,
			Gateway:     string(spec.Gateway),
			CNProvider:  spec.CNProvider,
		})
	}
	platforms = append(platforms, MetadataPlatformOption{
		ID:          domain.PlatformComposite,
		DisplayName: "Composite (多平台组合)",
		Gateway:     "composite",
		Composite:   true,
	})

	subscriptionTypes := []MetadataSubscriptionTypeOption{
		{ID: domain.SubscriptionTypeStandard, DisplayName: "标准余额计费 (standard)"},
		{ID: domain.SubscriptionTypeSubscription, DisplayName: "订阅限额模式 (subscription)"},
	}

	response.Success(c, gin.H{
		"platforms":          platforms,
		"subscription_types": subscriptionTypes,
	})
}
