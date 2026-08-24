import { test } from "node:test";
import assert from "node:assert";
import {
  isPrivateIPAddress,
  isPrivateHostname,
  stripBrackets,
} from "./ssrf";

test("isPrivateIPAddress: IPv4 private and reserved ranges", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "0.0.0.0",
    "100.64.0.1", // CGNAT
    "198.18.0.5", // benchmarking
    "224.0.0.1", // multicast
    "240.0.0.1", // reserved
    "255.255.255.255",
    "192.0.2.9", // TEST-NET-1
  ]) {
    assert.strictEqual(isPrivateIPAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIPAddress: public IPv4 addresses are allowed", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.121.4", "172.32.0.1"]) {
    assert.strictEqual(isPrivateIPAddress(ip), false, `${ip} should be public`);
  }
});

test("isPrivateIPAddress: IPv6 loopback / link-local / unique local", () => {
  for (const ip of ["::1", "::", "fe80::1", "fd00::1", "fc00::abcd", "2001:db8::1"]) {
    assert.strictEqual(isPrivateIPAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIPAddress: IPv4-mapped IPv6 bypass is blocked", () => {
  for (const ip of [
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "::FFFF:192.168.0.1",
  ]) {
    assert.strictEqual(isPrivateIPAddress(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIPAddress: zone ids are stripped", () => {
  assert.strictEqual(isPrivateIPAddress("fe80::1%eth0"), true);
  assert.strictEqual(isPrivateIPAddress("::ffff:127.0.0.1%1"), true);
});

test("isPrivateIPAddress: public IPv6 addresses are allowed", () => {
  assert.strictEqual(isPrivateIPAddress("2606:4700:4700::1111"), false);
  assert.strictEqual(isPrivateIPAddress("febf::1"), true); // still link-local
  assert.strictEqual(isPrivateIPAddress("fec0::1"), false); // deprecated site-local, not blocked
});

test("isPrivateIPAddress: invalid input is treated as private", () => {
  assert.strictEqual(isPrivateIPAddress("not-an-ip"), true);
  assert.strictEqual(isPrivateIPAddress("999.999.999.999"), true);
});

test("isPrivateHostname: localhost variants and metadata names", () => {
  assert.strictEqual(isPrivateHostname("localhost"), true);
  assert.strictEqual(isPrivateHostname("api.localhost"), true);
  assert.strictEqual(isPrivateHostname("foo.local"), true);
  assert.strictEqual(isPrivateHostname("service.internal"), true);
  assert.strictEqual(isPrivateHostname("metadata.google.internal"), true);
  assert.strictEqual(isPrivateHostname("LOCALHOST."), true); // FQDN trailing dot
  assert.strictEqual(isPrivateHostname("example.com"), false);
  assert.strictEqual(isPrivateHostname("localhost.example.com"), false);
});

test("stripBrackets: IPv6 literal brackets are removed", () => {
  assert.strictEqual(stripBrackets("[::1]"), "::1");
  assert.strictEqual(stripBrackets("example.com"), "example.com");
});
