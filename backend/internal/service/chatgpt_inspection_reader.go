// The strict read contract is shared with NeedToken glue internal/iapmvp/chatgpt.go.
// Credentials remain in this Sub2API process; no transaction ownership is implied.
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
	"net/url"
	"strings"
	"time"
)

const (
	chatGPTInspectionAccountURL      = "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27"
	chatGPTInspectionSubscriptionURL = "https://chatgpt.com/backend-api/subscriptions"
	chatGPTInspectionReadLimit       = 1024 * 1024
	chatGPTInspectionReadTimeout     = 15 * time.Second
)

var (
	errChatGPTInspectionUnauthorized    = errors.New("iap probe: target authentication rejected")
	errChatGPTInspectionChallenge       = errors.New("iap probe: target interaction required")
	errChatGPTInspectionUnavailable     = errors.New("iap probe: target read unavailable")
	errChatGPTInspectionResponse        = errors.New("iap probe: target response invalid or incomplete")
	errChatGPTInspectionAccountMismatch = errors.New("iap probe: target account does not match")
)

// chatGPTInspectionSnapshot is a read-only observation of one exact account. It does not
// establish personal-account ownership, Apple transaction ownership, or IAP
// association, and deliberately cannot satisfy the Verifier interface.
type chatGPTInspectionSnapshot struct {
	AccountID      string    `json:"-"`
	Plan           string    `json:"plan"`
	ExpiresAt      time.Time `json:"expires_at,omitempty"`
	ObservedAt     time.Time `json:"observed_at"`
	EvidenceSHA256 string    `json:"evidence_sha256"`
}

// chatGPTInspectionReader independently implements only the read contracts present in
// Wei-Shaw/sub2api at commit 358e4a89a1803e2e8d6fe8da9e24402e0f7a7518:
// backend/internal/service/openai_privacy_service.go (account and subscription
// GETs). Unlike its best-effort display code, this inspector never selects a
// default/paid workspace or mixes one account's plan with another's expiry.
// No live protocol claim follows from fixture tests or a successful snapshot.
type chatGPTInspectionReader struct {
	client *http.Client
	now    func() time.Time
}

func newChatGPTInspectionReader(client *http.Client) *chatGPTInspectionReader {
	var c http.Client
	if client != nil {
		c = *client
	}
	// Use normal system TLS and environment proxy defaults. Never carry a
	// caller cookie jar or follow redirects with an authorization header.
	c.Jar = nil
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	if c.Timeout <= 0 || c.Timeout > chatGPTInspectionReadTimeout {
		c.Timeout = chatGPTInspectionReadTimeout
	}
	return &chatGPTInspectionReader{client: &c, now: time.Now}
}

// Inspect accepts a short-lived ChatGPT access token. API keys and Codex PATs
// are different credentials and are not guessed onto these web endpoints.
// The caller must supply the already-whitelisted stable account ID. JWT claims
// are never used as identity or plan evidence, and no token is retained.
func (c *chatGPTInspectionReader) Inspect(ctx context.Context, accessToken, expectedAccountID string) (chatGPTInspectionSnapshot, error) {
	if c == nil || c.client == nil || !chatGPTInspectionReference(expectedAccountID) || !chatGPTInspectionAccessToken(accessToken) {
		return chatGPTInspectionSnapshot{}, ErrChatGPTInspectionInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, chatGPTInspectionReadTimeout)
	defer cancel()
	if ctx.Err() != nil {
		return chatGPTInspectionSnapshot{}, errChatGPTInspectionUnavailable
	}
	accountBody, err := c.read(ctx, accessToken, chatGPTInspectionAccountURL)
	if err != nil {
		return chatGPTInspectionSnapshot{}, err
	}
	defer clear(accountBody)
	account, err := inspectPinnedChatGPTAccount(accountBody, expectedAccountID)
	if err != nil {
		return chatGPTInspectionSnapshot{}, err
	}

	var subscriptionBody []byte
	if account.Plan == "go" || account.Plan == "plus" || account.Plan == "pro" {
		u, _ := url.Parse(chatGPTInspectionSubscriptionURL)
		q := u.Query()
		q.Set("account_id", expectedAccountID)
		u.RawQuery = q.Encode()
		subscriptionBody, err = c.read(ctx, accessToken, u.String())
		if err != nil {
			return chatGPTInspectionSnapshot{}, err
		}
		defer clear(subscriptionBody)
		expires, err := inspectPinnedChatGPTSubscription(subscriptionBody, account)
		if err != nil {
			return chatGPTInspectionSnapshot{}, err
		}
		account.ExpiresAt = expires
	}
	if ctx.Err() != nil {
		return chatGPTInspectionSnapshot{}, errChatGPTInspectionUnavailable
	}
	account.ObservedAt = c.now().UTC()
	h := sha256.New()
	_, _ = h.Write([]byte("chatgpt-read-v1\x00"))
	_, _ = h.Write(accountBody)
	_, _ = h.Write([]byte{0})
	_, _ = h.Write(subscriptionBody)
	account.EvidenceSHA256 = hex.EncodeToString(h.Sum(nil))
	return account, nil
}

func chatGPTInspectionAccessToken(token string) bool {
	if token == "" || len(token) > 16*1024 || strings.HasPrefix(token, "sk-") || strings.HasPrefix(token, "at-") {
		return false
	}
	for _, ch := range token {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || strings.ContainsRune("-._~+/=", ch)) {
			return false
		}
	}
	return true
}

func (c *chatGPTInspectionReader) read(ctx context.Context, token, endpoint string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, errChatGPTInspectionUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Origin", "https://chatgpt.com")
	req.Header.Set("Referer", "https://chatgpt.com/")
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, errChatGPTInspectionUnavailable
	}
	defer resp.Body.Close()
	if strings.EqualFold(strings.TrimSpace(resp.Header.Get("cf-mitigated")), "challenge") {
		return nil, errChatGPTInspectionChallenge
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, errChatGPTInspectionUnauthorized
	}
	if resp.StatusCode != http.StatusOK {
		return nil, errChatGPTInspectionUnavailable
	}
	if media := strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]); !strings.EqualFold(media, "application/json") {
		return nil, errChatGPTInspectionResponse
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, chatGPTInspectionReadLimit+1))
	if err != nil || len(body) > chatGPTInspectionReadLimit {
		clear(body)
		return nil, errChatGPTInspectionResponse
	}
	return body, nil
}

// readChatGPTInspectionObject rejects duplicate fields and trailing JSON. Providers may add
// unknown metadata; only the selected, strictly typed fields are read.
func readChatGPTInspectionObject(data []byte) (map[string]json.RawMessage, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	start, err := d.Token()
	if err != nil || start != json.Delim('{') {
		return nil, errChatGPTInspectionResponse
	}
	result := make(map[string]json.RawMessage)
	for d.More() {
		key, err := d.Token()
		name, ok := key.(string)
		if err != nil || !ok {
			return nil, errChatGPTInspectionResponse
		}
		if _, exists := result[name]; exists {
			return nil, errChatGPTInspectionResponse
		}
		var raw json.RawMessage
		if d.Decode(&raw) != nil {
			return nil, errChatGPTInspectionResponse
		}
		result[name] = raw
	}
	if end, err := d.Token(); err != nil || end != json.Delim('}') {
		return nil, errChatGPTInspectionResponse
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return nil, errChatGPTInspectionResponse
	}
	return result, nil
}

func readChatGPTInspectionOptionalString(m map[string]json.RawMessage, key string) (string, error) {
	raw, exists := m[key]
	if !exists {
		return "", nil
	}
	var s string
	if string(raw) == "null" || json.Unmarshal(raw, &s) != nil || strings.TrimSpace(s) != s {
		return "", errChatGPTInspectionResponse
	}
	return s, nil
}

func normalizeChatGPTInspectionPlan(raw string) (string, error) {
	if len(raw) == 0 || len(raw) > 64 {
		return "", errChatGPTInspectionResponse
	}
	for _, ch := range raw {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_' || ch == '-') {
			return "", errChatGPTInspectionResponse
		}
	}
	return strings.ToLower(raw), nil
}

func inspectPinnedChatGPTAccount(data []byte, expected string) (chatGPTInspectionSnapshot, error) {
	root, err := readChatGPTInspectionObject(data)
	if err != nil {
		return chatGPTInspectionSnapshot{}, err
	}
	accounts, err := readChatGPTInspectionObject(root["accounts"])
	if err != nil {
		return chatGPTInspectionSnapshot{}, err
	}
	var matched map[string]json.RawMessage
	matches := 0
	for _, raw := range accounts {
		entry, err := readChatGPTInspectionObject(raw)
		if err != nil {
			return chatGPTInspectionSnapshot{}, err
		}
		account, err := readChatGPTInspectionObject(entry["account"])
		if err != nil {
			return chatGPTInspectionSnapshot{}, err
		}
		id, err := readChatGPTInspectionOptionalString(account, "account_id")
		if err != nil {
			return chatGPTInspectionSnapshot{}, err
		}
		if id == expected {
			matches++
			matched = entry
		}
	}
	if matches == 0 {
		return chatGPTInspectionSnapshot{}, errChatGPTInspectionAccountMismatch
	}
	if matches != 1 {
		return chatGPTInspectionSnapshot{}, errChatGPTInspectionResponse
	}
	account, err := readChatGPTInspectionObject(matched["account"])
	if err != nil {
		return chatGPTInspectionSnapshot{}, err
	}
	if rejectedChatGPTInspectionAccountState(account) || rejectedChatGPTInspectionAccountState(matched) {
		return chatGPTInspectionSnapshot{}, errChatGPTInspectionResponse
	}
	plan, err := readChatGPTInspectionOptionalString(account, "plan_type")
	if err != nil {
		return chatGPTInspectionSnapshot{}, err
	}
	var expiry time.Time
	// The source's optional map/string lookups treat a null entitlement or
	// null expires_at as unavailable metadata. Neither can establish a plan;
	// paid accounts still need the separate subscription read below.
	if raw, exists := matched["entitlement"]; exists && !bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		entitlement, err := readChatGPTInspectionObject(raw)
		if err != nil {
			return chatGPTInspectionSnapshot{}, err
		}
		entitlementPlan, err := readChatGPTInspectionOptionalString(entitlement, "subscription_plan")
		if err != nil {
			return chatGPTInspectionSnapshot{}, err
		}
		if plan != "" && entitlementPlan != "" && !strings.EqualFold(plan, entitlementPlan) {
			return chatGPTInspectionSnapshot{}, errChatGPTInspectionResponse
		}
		if plan == "" {
			plan = entitlementPlan
		}
		expires := ""
		if rawExpiry := entitlement["expires_at"]; !bytes.Equal(bytes.TrimSpace(rawExpiry), []byte("null")) {
			expires, err = readChatGPTInspectionOptionalString(entitlement, "expires_at")
			if err != nil {
				return chatGPTInspectionSnapshot{}, err
			}
		}
		if expires != "" {
			expiry, err = time.Parse(time.RFC3339, expires)
			if err != nil {
				return chatGPTInspectionSnapshot{}, errChatGPTInspectionResponse
			}
		}
	}
	plan, err = normalizeChatGPTInspectionPlan(plan)
	if err != nil {
		return chatGPTInspectionSnapshot{}, err
	}
	return chatGPTInspectionSnapshot{AccountID: expected, Plan: plan, ExpiresAt: expiry}, nil
}

func rejectedChatGPTInspectionAccountState(account map[string]json.RawMessage) bool {
	for _, key := range []string{"deactivated", "is_deactivated", "disabled", "is_disabled"} {
		if raw, ok := account[key]; ok {
			var flag bool
			if json.Unmarshal(raw, &flag) != nil || flag {
				return true
			}
		}
	}
	for _, key := range []string{"deactivated_at", "disabled_at", "deleted_at"} {
		if raw, ok := account[key]; ok && string(raw) != "null" && string(raw) != `""` {
			return true
		}
	}
	for _, key := range []string{"status", "state"} {
		if raw, ok := account[key]; ok {
			var state string
			if json.Unmarshal(raw, &state) != nil {
				return true
			}
			switch strings.ToLower(state) {
			case "deactivated", "disabled", "deleted", "inactive", "suspended":
				return true
			}
		}
	}
	return false
}

func inspectPinnedChatGPTSubscription(data []byte, account chatGPTInspectionSnapshot) (time.Time, error) {
	subscription, err := readChatGPTInspectionObject(data)
	if err != nil {
		return time.Time{}, err
	}
	plan, err := readChatGPTInspectionOptionalString(subscription, "plan_type")
	if err != nil {
		return time.Time{}, err
	}
	plan, err = normalizeChatGPTInspectionPlan(plan)
	if err != nil || plan != account.Plan {
		return time.Time{}, errChatGPTInspectionResponse
	}
	if id, err := readChatGPTInspectionOptionalString(subscription, "account_id"); err != nil || id != "" && id != account.AccountID {
		return time.Time{}, errChatGPTInspectionAccountMismatch
	}
	rawExpiry, err := readChatGPTInspectionOptionalString(subscription, "active_until")
	if err != nil || rawExpiry == "" {
		return time.Time{}, errChatGPTInspectionResponse
	}
	expires, err := time.Parse(time.RFC3339, rawExpiry)
	if err != nil || !account.ExpiresAt.IsZero() && !expires.Equal(account.ExpiresAt) {
		return time.Time{}, errChatGPTInspectionResponse
	}
	return expires, nil
}
