import { Injectable } from '@nestjs/common';
import { RedisService as NestRedisService } from '@liaoliaots/nestjs-redis';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService {
  private readonly redis: Redis;

  constructor(private readonly redisService: NestRedisService) {
    this.redis = this.redisService.getOrThrow();
  }

  async get(key: string): Promise<string | null> {
    return await this.redis.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.redis.set(key, value);
  }

  async setex(key: string, seconds: number, value: string): Promise<void> {
    await this.redis.setex(key, seconds, value);
  }

  async del(...keys: string[]): Promise<number> {
    return await this.redis.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.redis.exists(key);
    return result === 1;
  }

  async expire(key: string, seconds: number): Promise<boolean> {
    const result = await this.redis.expire(key, seconds);
    return result === 1;
  }

  async keys(pattern: string): Promise<string[]> {
    return await this.redis.keys(pattern);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return await this.redis.hgetall(key);
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    return await this.redis.hset(key, field, value);
  }

  async hdel(key: string, field: string): Promise<number> {
    return await this.redis.hdel(key, field);
  }

  async ttl(key: string): Promise<number> {
    return await this.redis.ttl(key);
  }

  async incr(key: string): Promise<number> {
    return await this.redis.incr(key);
  }

  async publish(channel: string, message: string): Promise<number> {
    return await this.redis.publish(channel, message);
  }

  getRedisInstance(): Redis {
    return this.redis;
  }

  async eval(script: string, keys: string[], args: string[]): Promise<any> {
    return await this.redis.eval(script, keys.length, ...keys, ...args);
  }

  async flushdb(): Promise<string> {
    return await this.redis.flushdb();
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    return await this.redis.sadd(key, ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return await this.redis.smembers(key);
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    return await this.redis.srem(key, ...members);
  }

  async lpush(key: string, ...elements: string[]): Promise<number> {
    return await this.redis.lpush(key, ...elements);
  }

  async rpush(key: string, ...elements: string[]): Promise<number> {
    return await this.redis.rpush(key, ...elements);
  }

  async lpop(key: string): Promise<string | null> {
    return await this.redis.lpop(key);
  }

  async rpop(key: string): Promise<string | null> {
    return await this.redis.rpop(key);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return await this.redis.lrange(key, start, stop);
  }

  async ltrim(key: string, start: number, stop: number): Promise<string> {
    return await this.redis.ltrim(key, start, stop);
  }

  async llen(key: string): Promise<number> {
    return await this.redis.llen(key);
  }
}
