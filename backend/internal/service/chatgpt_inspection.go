package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/adminaccess"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/httpclient"
)

const ChatGPTInspectionPermission = "accounts.subscription.inspect"

var (
	ErrChatGPTInspectionDisabled            = infraerrors.New(http.StatusServiceUnavailable, "CHATGPT_INSPECTION_DISABLED", "ChatGPT inspection is disabled")
	ErrChatGPTInspectionInvalid             = infraerrors.New(http.StatusBadRequest, "CHATGPT_INSPECTION_INVALID", "Invalid ChatGPT inspection request")
	ErrChatGPTInspectionAccountNotFound     = infraerrors.New(http.StatusNotFound, "CHATGPT_INSPECTION_ACCOUNT_NOT_FOUND", "Inspection account is unavailable")
	ErrChatGPTInspectionPinMismatch         = infraerrors.New(http.StatusConflict, "CHATGPT_INSPECTION_PIN_MISMATCH", "Inspection policy or proxy pin does not match")
	ErrChatGPTInspectionIdentityChanged     = infraerrors.New(http.StatusConflict, "CHATGPT_INSPECTION_IDENTITY_CHANGED", "Inspection identity changed during the read")
	ErrChatGPTInspectionCredentialRejected  = infraerrors.New(http.StatusBadGateway, "CHATGPT_INSPECTION_CREDENTIAL_REJECTED", "Target credential was rejected")
	ErrChatGPTInspectionInteractionRequired = infraerrors.New(http.StatusBadGateway, "CHATGPT_INSPECTION_INTERACTION_REQUIRED", "Target requires interaction")
	ErrChatGPTInspectionResponseUnverified  = infraerrors.New(http.StatusBadGateway, "CHATGPT_INSPECTION_RESPONSE_UNVERIFIED", "Target response could not be verified")
	ErrChatGPTInspectionUpstreamUnavailable = infraerrors.New(http.StatusBadGateway, "CHATGPT_INSPECTION_UPSTREAM_UNAVAILABLE", "Target inspection is unavailable")
)

// ChatGPTInspectionRequest contains expected references, never a credential or
// proxy URL. Both references must match the immutable startup allowlist.
type ChatGPTInspectionRequest struct {
	ExpectedProxyID          int64  `json:"expected_proxy_id"`
	ExpectedChatGPTAccountID string `json:"expected_chatgpt_account_id"`
}

type ChatGPTInspectionObservation struct {
	AccountSHA256  string     `json:"account_sha256"`
	Plan           string     `json:"plan"`
	ExpiresAt      *time.Time `json:"expires_at,omitempty"`
	ObservedAt     time.Time  `json:"observed_at"`
	EvidenceSHA256 string     `json:"evidence_sha256"`
}

// ChatGPTInspectionReport cannot indicate purchase or delivery success. A fixed
// configured proxy also does not prove a vendor's actual public exit stayed fixed.
type ChatGPTInspectionReport struct {
	Campaign                     string                       `json:"campaign"`
	Status                       string                       `json:"status"`
	Code                         string                       `json:"code"`
	NativeAccountID              int64                        `json:"native_account_id"`
	ConfiguredProxyID            int64                        `json:"configured_proxy_id"`
	ProxyPinVerified             bool                         `json:"proxy_pin_verified"`
	ActualEgressIPVerified       bool                         `json:"actual_egress_ip_verified"`
	ReadOnly                     bool                         `json:"read_only"`
	PurchaseAttempted            bool                         `json:"purchase_attempted"`
	TransactionOwnershipVerified bool                         `json:"transaction_ownership_verified"`
	MVP0Passed                   bool                         `json:"mvp0_passed"`
	SalesEnabled                 bool                         `json:"sales_enabled"`
	Observation                  ChatGPTInspectionObservation `json:"observation"`
}

// ChatGPTAccountInspector is deliberately separate from AdminService's broad
// read/write interface, and never returns account or proxy credential documents.
type ChatGPTAccountInspector interface {
	InspectChatGPTAccount(context.Context, int64, ChatGPTInspectionRequest) (*ChatGPTInspectionReport, error)
}

type chatGPTInspectionPolicy struct {
	AccountID        int64  `json:"account_id"`
	ProxyID          int64  `json:"proxy_id"`
	ChatGPTAccountID string `json:"chatgpt_account_id"`
}

var chatGPTInspectionReferencePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$`)

func chatGPTInspectionReference(s string) bool {
	return chatGPTInspectionReferencePattern.MatchString(s)
}

func parseChatGPTInspectionPolicies(cfg *config.Config) (map[int64]chatGPTInspectionPolicy, error) {
	policies := map[int64]chatGPTInspectionPolicy{}
	if cfg == nil {
		return policies, nil
	}
	raw := cfg.ChatGPTInspectionPolicies
	if len(raw) > 32*1024 {
		return nil, ErrChatGPTInspectionInvalid
	}
	if strings.TrimSpace(raw) == "" {
		return policies, nil
	}
	d := json.NewDecoder(strings.NewReader(raw))
	start, err := d.Token()
	if err != nil || start != json.Delim('[') {
		return nil, ErrChatGPTInspectionInvalid
	}
	for d.More() {
		var item json.RawMessage
		if d.Decode(&item) != nil || len(policies) >= 64 {
			return nil, ErrChatGPTInspectionInvalid
		}
		fields, err := readChatGPTInspectionObject(item)
		if err != nil || len(fields) != 3 || fields["account_id"] == nil || fields["proxy_id"] == nil || fields["chatgpt_account_id"] == nil {
			return nil, ErrChatGPTInspectionInvalid
		}
		decoder := json.NewDecoder(bytes.NewReader(item))
		decoder.DisallowUnknownFields()
		var p chatGPTInspectionPolicy
		if decoder.Decode(&p) != nil || p.AccountID <= 0 || p.ProxyID <= 0 || !chatGPTInspectionReference(p.ChatGPTAccountID) {
			return nil, ErrChatGPTInspectionInvalid
		}
		if _, exists := policies[p.AccountID]; exists {
			return nil, ErrChatGPTInspectionInvalid
		}
		policies[p.AccountID] = p
	}
	if end, err := d.Token(); err != nil || end != json.Delim(']') {
		return nil, ErrChatGPTInspectionInvalid
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return nil, ErrChatGPTInspectionInvalid
	}
	return policies, nil
}

type chatGPTInspectionIdentity struct {
	accountID                     int64
	platform, accountType, status string
	proxyID                       int64
	credentials                   string
	proxy                         Proxy
}

func newChatGPTInspectionIdentity(account *Account, proxy *Proxy) (chatGPTInspectionIdentity, error) {
	credentials, err := json.Marshal(account.Credentials)
	if err != nil {
		return chatGPTInspectionIdentity{}, ErrChatGPTInspectionResponseUnverified
	}
	copyProxy := *proxy
	if proxy.ExpiresAt != nil {
		expiry := *proxy.ExpiresAt
		copyProxy.ExpiresAt = &expiry
	}
	return chatGPTInspectionIdentity{accountID: account.ID, platform: account.Platform, accountType: account.Type,
		status: account.Status, proxyID: *account.ProxyID, credentials: string(credentials), proxy: copyProxy}, nil
}

func (i chatGPTInspectionIdentity) matches(other chatGPTInspectionIdentity) bool {
	// Compare the effective request identity, not UpdatedAt (normal usage may
	// update that timestamp). Never expose the credential comparison material.
	if i.accountID != other.accountID || i.platform != other.platform || i.accountType != other.accountType ||
		i.status != other.status || i.proxyID != other.proxyID || i.credentials != other.credentials {
		return false
	}
	a, b := i.proxy, other.proxy
	return a.ID == b.ID && a.Protocol == b.Protocol && a.Host == b.Host && a.Port == b.Port &&
		a.Username == b.Username && a.Password == b.Password && a.Status == b.Status &&
		a.FallbackMode == b.FallbackMode && a.BackupProxyID == nil && b.BackupProxyID == nil &&
		(a.ExpiresAt == nil && b.ExpiresAt == nil || a.ExpiresAt != nil && b.ExpiresAt != nil && a.ExpiresAt.Equal(*b.ExpiresAt))
}

func (s *adminServiceImpl) loadChatGPTInspectionIdentity(ctx context.Context, id int64, expectedProxy int64) (*Account, *Proxy, chatGPTInspectionIdentity, error) {
	if s.accountRepo == nil || s.proxyRepo == nil {
		return nil, nil, chatGPTInspectionIdentity{}, ErrChatGPTInspectionDisabled
	}
	account, err := s.accountRepo.GetByID(ctx, id)
	if err != nil || account == nil || account.ID != id || account.Platform != PlatformOpenAI || account.Type != AccountTypeOAuth || account.ParentAccountID != nil || account.Status != StatusActive {
		return nil, nil, chatGPTInspectionIdentity{}, ErrChatGPTInspectionAccountNotFound
	}
	if principal := adminaccess.FromContext(ctx); principal != nil && !principal.Policy.AllowsAccount(ChatGPTInspectionPermission,
		adminaccess.Account{ID: account.ID, Platform: account.Platform, Type: account.Type, GroupIDs: account.GroupIDs}) {
		return nil, nil, chatGPTInspectionIdentity{}, ErrChatGPTInspectionAccountNotFound
	}
	if account.ProxyID == nil || *account.ProxyID != expectedProxy {
		return nil, nil, chatGPTInspectionIdentity{}, ErrChatGPTInspectionPinMismatch
	}
	proxy, err := s.proxyRepo.GetByID(ctx, expectedProxy)
	if err != nil || proxy == nil || proxy.ID != expectedProxy || proxy.Status != StatusActive || proxy.IsExpired(time.Now()) ||
		proxy.FallbackMode != FallbackModeNone || proxy.BackupProxyID != nil || proxy.Host == "" || proxy.Port < 1 || proxy.Port > 65535 ||
		(proxy.Username == "") != (proxy.Password == "") {
		return nil, nil, chatGPTInspectionIdentity{}, ErrChatGPTInspectionPinMismatch
	}
	switch proxy.Protocol {
	case "http", "https", "socks5", "socks5h":
	default:
		return nil, nil, chatGPTInspectionIdentity{}, ErrChatGPTInspectionPinMismatch
	}
	identity, err := newChatGPTInspectionIdentity(account, proxy)
	return account, proxy, identity, err
}

// InspectChatGPTAccount reads the current access token and exact proxy internally.
// It never refreshes credentials, mutates privacy settings, rewrites binding or
// falls back to direct networking. All returned errors contain controlled text.
func (s *adminServiceImpl) InspectChatGPTAccount(ctx context.Context, accountID int64, request ChatGPTInspectionRequest) (*ChatGPTInspectionReport, error) {
	if s == nil || s.chatGPTInspectionPolicyInvalid || len(s.chatGPTInspectionPolicies) == 0 {
		return nil, ErrChatGPTInspectionDisabled
	}
	if accountID <= 0 || request.ExpectedProxyID <= 0 || !chatGPTInspectionReference(request.ExpectedChatGPTAccountID) {
		return nil, ErrChatGPTInspectionInvalid
	}
	policy, ok := s.chatGPTInspectionPolicies[accountID]
	if !ok {
		return nil, ErrChatGPTInspectionAccountNotFound
	}
	if policy.ProxyID != request.ExpectedProxyID || policy.ChatGPTAccountID != request.ExpectedChatGPTAccountID {
		return nil, ErrChatGPTInspectionPinMismatch
	}
	ctx, cancel := context.WithTimeout(ctx, chatGPTInspectionReadTimeout)
	defer cancel()
	account, proxy, before, err := s.loadChatGPTInspectionIdentity(ctx, accountID, policy.ProxyID)
	if err != nil {
		return nil, err
	}
	token := account.GetCredential("access_token")
	if !chatGPTInspectionAccessToken(token) {
		return nil, ErrChatGPTInspectionCredentialRejected
	}
	factory := s.chatGPTInspectionClient
	if factory == nil {
		factory = func(proxyURL string) (*http.Client, error) {
			return httpclient.GetClient(httpclient.Options{ProxyURL: proxyURL, Timeout: chatGPTInspectionReadTimeout,
				ResponseHeaderTimeout: chatGPTInspectionReadTimeout})
		}
	}
	client, err := factory(proxy.URL())
	if err != nil || client == nil {
		return nil, ErrChatGPTInspectionUpstreamUnavailable
	}
	snapshot, err := newChatGPTInspectionReader(client).Inspect(ctx, token, policy.ChatGPTAccountID)
	if err != nil {
		switch {
		case errors.Is(err, errChatGPTInspectionUnauthorized):
			return nil, ErrChatGPTInspectionCredentialRejected
		case errors.Is(err, errChatGPTInspectionChallenge):
			return nil, ErrChatGPTInspectionInteractionRequired
		case errors.Is(err, errChatGPTInspectionResponse), errors.Is(err, errChatGPTInspectionAccountMismatch):
			return nil, ErrChatGPTInspectionResponseUnverified
		default:
			return nil, ErrChatGPTInspectionUpstreamUnavailable
		}
	}
	_, _, after, err := s.loadChatGPTInspectionIdentity(ctx, accountID, policy.ProxyID)
	if err != nil || !before.matches(after) {
		return nil, ErrChatGPTInspectionIdentityChanged
	}
	accountHash := sha256.Sum256([]byte(snapshot.AccountID))
	// Bind the redacted evidence to the selected native account and proxy IDs.
	evidence := sha256.Sum256([]byte("sub2api-chatgpt-inspection-v1\x00" + strconv.FormatInt(accountID, 10) + "\x00" + strconv.FormatInt(policy.ProxyID, 10) + "\x00" + snapshot.EvidenceSHA256))
	observation := ChatGPTInspectionObservation{AccountSHA256: hex.EncodeToString(accountHash[:]), Plan: safeChatGPTInspectionPlan(snapshot.Plan),
		ObservedAt: snapshot.ObservedAt, EvidenceSHA256: hex.EncodeToString(evidence[:])}
	if !snapshot.ExpiresAt.IsZero() {
		expiry := snapshot.ExpiresAt
		observation.ExpiresAt = &expiry
	}
	return &ChatGPTInspectionReport{Campaign: "chatgpt-plus-us-mvp0", Status: "blocked", Code: "apple_transaction_ownership_unverified",
		NativeAccountID: accountID, ConfiguredProxyID: policy.ProxyID, ProxyPinVerified: true, ReadOnly: true, Observation: observation}, nil
}

func safeChatGPTInspectionPlan(plan string) string {
	switch plan {
	case "free", "go", "plus", "pro", "team", "business", "enterprise", "edu":
		return plan
	default:
		return "unknown"
	}
}

var _ ChatGPTAccountInspector = (*adminServiceImpl)(nil)
