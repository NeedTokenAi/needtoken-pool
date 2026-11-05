package adminaccess

import "testing"

func TestChatGPTInspectionRouteNeedsItsOwnAccountPermission(t *testing.T) {
	const path = "/api/v1/admin/accounts/:id/chatgpt-inspection"
	for _, permission := range []string{"accounts.read", "accounts.refresh", "ops.read", "proxies.read"} {
		policy := Policy{GlobalPermissions: []string{permission}, Rules: []Rule{{Permissions: []string{permission}, AllGroups: true, AccountTypes: []string{"oauth"}, Platforms: []string{"openai"}}}}
		if RouteAllowed(policy, "POST", path) {
			t.Fatalf("%s implicitly authorizes inspection", permission)
		}
	}
	policy := Policy{Rules: []Rule{{Permissions: []string{"accounts.subscription.inspect"}, GroupIDs: []int64{4}, AccountTypes: []string{"oauth"}, Platforms: []string{"openai"}}}}
	if err := ValidatePolicy(policy); err != nil {
		t.Fatal(err)
	}
	if !RouteAllowed(policy, "POST", path) {
		t.Fatal("explicit inspection route not authorized")
	}
	for _, other := range []struct{ method, path string }{{"GET", path}, {"GET", "/api/v1/admin/accounts/:id"}, {"POST", "/api/v1/admin/accounts/:id/refresh"}, {"GET", "/api/v1/admin/proxies/:id"}} {
		if RouteAllowed(policy, other.method, other.path) {
			t.Fatalf("inspection scope expanded into %s %s", other.method, other.path)
		}
	}
}
