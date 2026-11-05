package admin

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

const chatGPTInspectionPermission = service.ChatGPTInspectionPermission

// InspectChatGPTAccount reads one existing, explicitly pinned account through
// its current proxy. It never accepts credentials or an arbitrary upstream URL.
func (h *AccountHandler) InspectChatGPTAccount(c *gin.Context) {
	accountID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || accountID <= 0 {
		chatGPTInspectionError(c, http.StatusBadRequest, "CHATGPT_INSPECTION_INVALID")
		return
	}
	if h.adminService == nil {
		chatGPTInspectionError(c, http.StatusServiceUnavailable, "CHATGPT_INSPECTION_DISABLED")
		return
	}
	if principal := adminaccess.FromContext(c.Request.Context()); principal != nil {
		// Resource checks remain here even though middleware already checked the
		// route, so this action cannot inherit broader account/ops read access.
		if len(principal.Policy.RulesFor(chatGPTInspectionPermission)) == 0 {
			chatGPTInspectionError(c, http.StatusForbidden, "CHATGPT_INSPECTION_FORBIDDEN")
			return
		}
		account, lookupErr := h.adminService.GetAccount(c.Request.Context(), accountID)
		if lookupErr != nil || account == nil || account.Platform != service.PlatformOpenAI || account.Type != service.AccountTypeOAuth ||
			!principal.Policy.AllowsAccount(chatGPTInspectionPermission, adminaccess.Account{
				ID: accountID, Platform: account.Platform, Type: account.Type, GroupIDs: account.GroupIDs,
			}) {
			chatGPTInspectionError(c, http.StatusNotFound, "CHATGPT_INSPECTION_ACCOUNT_NOT_FOUND")
			return
		}
	}
	request, err := decodeChatGPTInspectionRequest(c.Request.Body)
	if err != nil {
		chatGPTInspectionError(c, http.StatusBadRequest, "CHATGPT_INSPECTION_INVALID")
		return
	}
	inspector, ok := h.adminService.(service.ChatGPTAccountInspector)
	if !ok {
		chatGPTInspectionError(c, http.StatusServiceUnavailable, "CHATGPT_INSPECTION_DISABLED")
		return
	}
	report, err := inspector.InspectChatGPTAccount(c.Request.Context(), accountID, request)
	if err != nil {
		// The service emits controlled errors, but avoid forwarding even their
		// text or metadata; future transport errors may contain bearer material.
		status, reason := chatGPTInspectionServiceError(err)
		chatGPTInspectionError(c, status, reason)
		return
	}
	if report == nil || report.NativeAccountID != accountID || report.ConfiguredProxyID != request.ExpectedProxyID ||
		report.Campaign != "chatgpt-plus-us-mvp0" || report.Status != "blocked" || report.Code != "apple_transaction_ownership_unverified" ||
		!report.ReadOnly || !report.ProxyPinVerified || report.ActualEgressIPVerified || report.PurchaseAttempted ||
		report.TransactionOwnershipVerified || report.MVP0Passed || report.SalesEnabled {
		chatGPTInspectionError(c, http.StatusBadGateway, "CHATGPT_INSPECTION_RESPONSE_UNVERIFIED")
		return
	}
	c.Header("Cache-Control", "no-store")
	response.Success(c, report)
}

func chatGPTInspectionServiceError(err error) (int, string) {
	reason := infraerrors.Reason(err)
	switch reason {
	case "CHATGPT_INSPECTION_DISABLED":
		return http.StatusServiceUnavailable, reason
	case "CHATGPT_INSPECTION_INVALID":
		return http.StatusBadRequest, reason
	case "CHATGPT_INSPECTION_ACCOUNT_NOT_FOUND":
		return http.StatusNotFound, reason
	case "CHATGPT_INSPECTION_PIN_MISMATCH", "CHATGPT_INSPECTION_IDENTITY_CHANGED":
		return http.StatusConflict, reason
	case "CHATGPT_INSPECTION_CREDENTIAL_REJECTED", "CHATGPT_INSPECTION_INTERACTION_REQUIRED", "CHATGPT_INSPECTION_RESPONSE_UNVERIFIED", "CHATGPT_INSPECTION_UPSTREAM_UNAVAILABLE":
		return http.StatusBadGateway, reason
	default:
		return http.StatusBadGateway, "CHATGPT_INSPECTION_UPSTREAM_UNAVAILABLE"
	}
}

func chatGPTInspectionError(c *gin.Context, status int, reason string) {
	c.Header("Cache-Control", "no-store")
	response.ErrorWithDetails(c, status, "ChatGPT inspection unavailable", reason, nil)
}

func decodeChatGPTInspectionRequest(body io.Reader) (service.ChatGPTInspectionRequest, error) {
	var out service.ChatGPTInspectionRequest
	if body == nil {
		return out, io.ErrUnexpectedEOF
	}
	data, err := io.ReadAll(io.LimitReader(body, 4097))
	if err != nil || len(data) > 4096 {
		return out, io.ErrUnexpectedEOF
	}
	defer clear(data)
	decoder := json.NewDecoder(bytes.NewReader(data))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return out, io.ErrUnexpectedEOF
	}
	seen := map[string]bool{}
	for decoder.More() {
		rawKey, err := decoder.Token()
		key, ok := rawKey.(string)
		if err != nil || !ok || seen[key] {
			return out, io.ErrUnexpectedEOF
		}
		seen[key] = true
		switch key {
		case "expected_proxy_id":
			err = decoder.Decode(&out.ExpectedProxyID)
		case "expected_chatgpt_account_id":
			err = decoder.Decode(&out.ExpectedChatGPTAccountID)
		default:
			return out, io.ErrUnexpectedEOF
		}
		if err != nil {
			return out, io.ErrUnexpectedEOF
		}
	}
	if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
		return out, io.ErrUnexpectedEOF
	}
	if _, err := decoder.Token(); err != io.EOF || out.ExpectedProxyID <= 0 ||
		out.ExpectedChatGPTAccountID == "" || len(out.ExpectedChatGPTAccountID) > 160 ||
		strings.TrimSpace(out.ExpectedChatGPTAccountID) != out.ExpectedChatGPTAccountID {
		return out, io.ErrUnexpectedEOF
	}
	return out, nil
}
