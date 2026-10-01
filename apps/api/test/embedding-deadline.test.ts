import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { HttpMemoryEmbeddingProvider } from "../src/embeddings.js";

it("aborts a real HTTP response that stalls after its headers", async () => {
  let closed!: () => void;
  const disconnected = new Promise<void>((resolve) => { closed = resolve; });
  const server = createServer((_request,response) => { response.writeHead(200,{"content-type":"application/json"}); response.write('{"embeddings":'); response.on("close",closed); });
  await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));
  const provider = new HttpMemoryEmbeddingProvider({ url:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,model:"test",dimensions:3,timeoutMs:30 });
  try { await expect(provider.embed(["query"])).rejects.toThrow(/timed out/); await disconnected; }
  finally { await provider.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

it("bounds streamed response bytes before parsing and isolates provider configuration identity", async () => {
  const options = { url:"https://example.test/embed",model:"test",dimensions:3,maxResponseBytes:12,fetch:async()=>new Response('{"embeddings":[[1,0,0]]}') };
  const provider = new HttpMemoryEmbeddingProvider(options);
  await expect(provider.embed(["query"])).rejects.toThrow(/byte limit/);
  expect(new HttpMemoryEmbeddingProvider({...options,token:"rotated"}).descriptor).toEqual(provider.descriptor);
  expect(new HttpMemoryEmbeddingProvider({...options,url:"https://example.test/other"}).descriptor.id).not.toBe(provider.descriptor.id);
});

it("does not create unlimited underlying requests when a custom fetch ignores cancellation", async () => {
  let calls=0;
  const provider=new HttpMemoryEmbeddingProvider({url:"https://example.test/embed",model:"test",dimensions:3,timeoutMs:5,fetch:async()=>{calls++;return new Promise(()=>undefined);}});
  for(let i=0;i<8;i++) await expect(provider.embed(["query"])).rejects.toThrow(/timed out|capacity/);
  expect(calls).toBe(4);await provider.close();
});
