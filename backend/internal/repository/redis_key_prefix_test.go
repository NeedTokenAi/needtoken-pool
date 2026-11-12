//go:build unit

package repository

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/require"
)

func TestRedisKeyPrefixLeavesNoBareKey(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	installRedisKeyPrefix(client, "iso:")

	ctx := context.Background()
	bare := []string{
		"leader:lock:job",
		"rate_limit:ip",
		"billing:balance:1",
		"session_limit:account:7",
		"channel:refresh",
	}
	require.NoError(t, client.Set(ctx, bare[0], "owner", time.Minute).Err())
	require.NoError(t, client.SetNX(ctx, bare[0], "other", time.Minute).Err())
	require.NoError(t, client.MSet(ctx, bare[2], "1", bare[3], "2").Err())
	require.NoError(t, client.HSet(ctx, "apikey:rate:4", "daily", "1").Err())
	require.NoError(t, client.ZAdd(ctx, "rpm:1:2", redis.Z{Score: 1, Member: "a"}).Err())
	require.NoError(t, client.SAdd(ctx, "plugin:kv:v1:a", "m").Err())
	require.NoError(t, client.Incr(ctx, bare[1]).Err())
	require.NoError(t, client.Expire(ctx, bare[1], time.Minute).Err())
	channel := bare[4]
	require.NoError(t, client.Publish(ctx, channel, "refresh").Err())

	script := redis.NewScript(`
		redis.call('SET', KEYS[1], '1')
		redis.call('SET', KEYS[1] .. ':sequence', '1')
		redis.call('SET', ARGV[1] .. ARGV[2], '1')
		return 1
	`)
	snapshot := prefixRedisKey(client, "scheduler:snapshot:1:openai:v")
	require.NoError(t, script.Run(ctx, client, []string{"concurrency:account:3"}, snapshot, "9").Err())

	lock := NewLeaderLockCache(client)
	ok, err := lock.TryAcquireLeaderLock(ctx, "batch", "owner", time.Minute)
	require.NoError(t, err)
	require.True(t, ok)

	keys := mr.Keys()
	require.NotEmpty(t, keys)
	for _, key := range keys {
		require.Truef(t, len(key) >= len("iso:") && key[:len("iso:")] == "iso:", "bare key %q", key)
	}
	for _, key := range []string{
		bare[0], bare[1], bare[2], bare[3],
		"apikey:rate:4",
		"rpm:1:2",
		"plugin:kv:v1:a",
		"concurrency:account:3",
		"concurrency:account:3:sequence",
		"scheduler:snapshot:1:openai:v9",
		"leader:lock:batch",
	} {
		require.Falsef(t, mr.Exists(key), "bare key remained: %s", key)
		require.Truef(t, mr.Exists("iso:"+key), "prefixed key missing: iso:%s", key)
	}
	require.False(t, mr.Exists(channel))

	raw := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = raw.Close() })
	sub := raw.Subscribe(ctx, "iso:"+channel)
	t.Cleanup(func() { _ = sub.Close() })
	_, err = sub.Receive(ctx)
	require.NoError(t, err)
	require.NoError(t, client.Publish(ctx, channel, "again").Err())
	select {
	case message := <-sub.Channel():
		require.Equal(t, "again", message.Payload)
	case <-time.After(time.Second):
		t.Fatal("prefixed channel received nothing")
	}
	bareSub := raw.Subscribe(ctx, channel)
	t.Cleanup(func() { _ = bareSub.Close() })
	_, err = bareSub.Receive(ctx)
	require.NoError(t, err)
	require.NoError(t, client.Publish(ctx, channel, "third").Err())
	select {
	case <-bareSub.Channel():
		t.Fatal("bare channel received a message")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestRedisKeyPrefixEmptyIsUnchanged(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	installRedisKeyPrefix(client, "   ")

	ctx := context.Background()
	require.NoError(t, client.Set(ctx, "leader:lock:job", "owner", 0).Err())
	require.NoError(t, client.Publish(ctx, "channel:refresh", "1").Err())
	require.NoError(t, redis.NewScript(`redis.call('SET', KEYS[1], '1') return 1`).Run(ctx, client, []string{"rate_limit:ip"}).Err())
	require.True(t, mr.Exists("leader:lock:job"))
	require.True(t, mr.Exists("rate_limit:ip"))
	require.False(t, mr.Exists("iso:leader:lock:job"))
	require.Equal(t, "scheduler:snapshot:v", prefixRedisKey(client, "scheduler:snapshot:v"))
}
