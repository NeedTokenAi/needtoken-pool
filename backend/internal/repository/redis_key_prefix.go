package repository

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/redis/go-redis/v9"
)

// redisClientPrefixes records the prefix installed on a client. An empty
// prefix is never stored and never installs a hook, so command arguments stay
// exactly as they are today.
var redisClientPrefixes sync.Map

// installRedisKeyPrefix prefixes every Redis key, pub/sub channel, lock, and
// rate-limit key sent by client. A blank prefix does nothing.
func installRedisKeyPrefix(client *redis.Client, prefix string) {
	prefix = strings.TrimSpace(prefix)
	if client == nil || prefix == "" {
		return
	}
	redisClientPrefixes.Store(client, prefix)
	client.AddHook(redisKeyPrefixHook{prefix: prefix})
}

// prefixRedisKey applies the client's prefix to a key fragment that a Lua
// script concatenates itself. With no prefix the fragment is returned unchanged.
func prefixRedisKey(client *redis.Client, key string) string {
	prefix := redisKeyPrefixOf(client)
	if prefix == "" || key == "" || strings.HasPrefix(key, prefix) {
		return key
	}
	return prefix + key
}

func redisKeyPrefixOf(client *redis.Client) string {
	if client == nil {
		return ""
	}
	value, ok := redisClientPrefixes.Load(client)
	if !ok {
		return ""
	}
	prefix, _ := value.(string)
	return prefix
}

type redisKeyPrefixHook struct {
	prefix string
}

func (h redisKeyPrefixHook) DialHook(next redis.DialHook) redis.DialHook { return next }

func (h redisKeyPrefixHook) ProcessHook(next redis.ProcessHook) redis.ProcessHook {
	return func(ctx context.Context, cmd redis.Cmder) error {
		h.prefixCmd(cmd)
		return next(ctx, cmd)
	}
}

func (h redisKeyPrefixHook) ProcessPipelineHook(next redis.ProcessPipelineHook) redis.ProcessPipelineHook {
	return func(ctx context.Context, cmds []redis.Cmder) error {
		for _, cmd := range cmds {
			h.prefixCmd(cmd)
		}
		return next(ctx, cmds)
	}
}

func (h redisKeyPrefixHook) prefixCmd(cmd redis.Cmder) {
	if h.prefix == "" || cmd == nil {
		return
	}
	prefixCommandArgs(h.prefix, cmd.Name(), cmd.Args())
}

func prefixCommandArgs(prefix, name string, args []any) {
	if prefix == "" || len(args) < 2 {
		return
	}
	prefixOne := func(i int) {
		if i < 0 || i >= len(args) {
			return
		}
		switch value := args[i].(type) {
		case string:
			if value != "" && !strings.HasPrefix(value, prefix) {
				args[i] = prefix + value
			}
		case []byte:
			text := string(value)
			if text != "" && !strings.HasPrefix(text, prefix) {
				args[i] = []byte(prefix + text)
			}
		}
	}
	prefixRange := func(start, end int) {
		if end > len(args) {
			end = len(args)
		}
		for i := start; i < end; i++ {
			prefixOne(i)
		}
	}
	prefixMatch := func(start int) {
		for i := start; i+1 < len(args); i++ {
			if strings.EqualFold(fmt.Sprint(args[i]), "match") {
				prefixOne(i + 1)
			}
		}
	}

	switch strings.ToLower(name) {
	case "get", "set", "setnx", "setex", "psetex", "getset", "getdel", "getex",
		"incr", "decr", "incrby", "incrbyfloat", "decrby", "append",
		"expire", "expireat", "pexpire", "pexpireat", "ttl", "pttl", "persist",
		"hget", "hset", "hsetnx", "hdel", "hexists", "hgetall", "hkeys", "hvals", "hlen",
		"hincrby", "hincrbyfloat", "hmget", "hmset", "hrandfield", "hscan",
		"zadd", "zcard", "zcount", "zincrby", "zrange", "zrangebyscore", "zrank",
		"zrem", "zremrangebyrank", "zremrangebyscore", "zrevrange", "zrevrangebyscore",
		"zrevrank", "zscore", "zscan", "zpopmin", "zpopmax",
		"sadd", "scard", "sismember", "smismember", "smembers", "srem", "spop", "srandmember", "sscan",
		"lpush", "lpushx", "rpush", "rpushx", "lpop", "rpop", "llen", "lrange", "ltrim", "lindex", "linsert", "lset", "lrem",
		"xadd", "xlen", "xrange", "xrevrange", "xtrim", "xdel", "xack", "xpending", "xgroup", "xinfo",
		"pfadd", "getbit", "setbit", "bitcount", "bitpos", "bitfield", "setrange", "getrange", "strlen",
		"type", "dump", "restore", "move", "object":
		if name == "object" {
			prefixOne(2)
			return
		}
		if name == "hscan" || name == "sscan" || name == "zscan" {
			prefixOne(1)
			prefixMatch(3)
			return
		}
		prefixOne(1)
	case "mget", "del", "unlink", "exists", "touch":
		prefixRange(1, len(args))
	case "mset", "msetnx":
		for i := 1; i < len(args); i += 2 {
			prefixOne(i)
		}
	case "rename", "renamenx", "copy", "lmove", "rpoplpush", "brpoplpush", "smove":
		prefixOne(1)
		prefixOne(2)
	case "blpop", "brpop", "bzpopmin", "bzpopmax":
		prefixRange(1, len(args)-1)
	case "eval", "evalsha", "eval_ro", "evalsha_ro", "fcall", "fcall_ro":
		if len(args) < 3 {
			return
		}
		numKeys, err := strconv.Atoi(fmt.Sprint(args[2]))
		if err != nil || numKeys <= 0 {
			return
		}
		prefixRange(3, 3+numKeys)
	case "publish", "spublish":
		prefixOne(1)
	case "subscribe", "unsubscribe", "psubscribe", "punsubscribe", "ssubscribe", "sunsubscribe":
		prefixRange(1, len(args))
	case "pubsub":
		if len(args) < 2 {
			return
		}
		switch strings.ToLower(fmt.Sprint(args[1])) {
		case "channels":
			prefixOne(2)
		case "numsub", "shardnumsub":
			prefixRange(2, len(args))
		}
	case "scan":
		prefixMatch(2)
	case "keys":
		prefixOne(1)
	}
}
