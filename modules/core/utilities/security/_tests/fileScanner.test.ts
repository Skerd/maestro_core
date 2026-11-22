import {afterEach, describe, expect, it} from "vitest";
import net from "net";
import {ClamAVScanner, MockFileScanner, parseClamdReply} from "@coreModule/utilities/security/fileScanner";

/** A stand-in clamd: reads one zINSTREAM upload, reassembles its chunks and answers with `reply`. */
async function fakeClamd(reply: string): Promise<{port: number; received: () => Buffer | undefined; close: () => void}> {
    let received: Buffer | undefined;
    const server = net.createServer(socket => {
        let data = Buffer.alloc(0);
        socket.on("data", chunk => {
            data = Buffer.concat([data, chunk]);
            const command = "zINSTREAM\0";
            if (data.length < command.length) return;
            const parts: Buffer[] = [];
            for (let offset = command.length; offset + 4 <= data.length;) {
                const size = data.readUInt32BE(offset);
                if (size === 0) {
                    received = Buffer.concat(parts);
                    socket.end(reply);
                    return;
                }
                if (offset + 4 + size > data.length) return;
                parts.push(data.subarray(offset + 4, offset + 4 + size));
                offset += 4 + size;
            }
        });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    return {port: (server.address() as net.AddressInfo).port, received: () => received, close: () => server.close()};
}

const servers: {close: () => void}[] = [];
afterEach(() => servers.splice(0).forEach(server => server.close()));

describe("parseClamdReply", () => {
    it("is clean only on an exact OK", () => {
        expect(parseClamdReply("stream: OK\0")).toMatchObject({safe: true, scanned: true});
    });

    it("treats a signature whose name contains OK as a threat", () => {
        expect(parseClamdReply("stream: Win.Trojan.Agent-OK1234 FOUND\0"))
            .toMatchObject({safe: false, scanned: true, threat: "Win.Trojan.Agent-OK1234"});
    });

    it("treats any other reply as not scanned, and unsafe", () => {
        expect(parseClamdReply("INSTREAM size limit exceeded. ERROR\0")).toMatchObject({safe: false, scanned: false});
        expect(parseClamdReply("")).toMatchObject({safe: false, scanned: false});
    });
});

describe("ClamAVScanner", () => {
    it("streams the whole file in chunks and reports a threat", async () => {
        const clamd = await fakeClamd("stream: Eicar-Test-Signature FOUND\0");
        servers.push(clamd);
        const file = Buffer.alloc(3 * 1024 * 1024 + 17, 7);

        const result = await new ClamAVScanner("127.0.0.1", clamd.port, 5000).scanFile("big.bin", file);

        expect(result).toMatchObject({safe: false, scanned: true});
        expect(clamd.received()?.equals(file)).toBe(true);
    });

    it("fails closed when clamd cannot be reached", async () => {
        const closed = await fakeClamd("stream: OK\0");
        closed.close();

        const result = await new ClamAVScanner("127.0.0.1", closed.port, 5000).scanFile("x.txt", Buffer.from("x"));

        expect(result).toMatchObject({safe: false, scanned: false});
    });
});

describe("MockFileScanner", () => {
    it("records files as not scanned, since it scans nothing", async () => {
        expect(await new MockFileScanner().scanFile("notes.txt", Buffer.from("hi"))).toMatchObject({safe: true, scanned: false});
    });

    it("still refuses a simulated threat", async () => {
        expect(await new MockFileScanner(undefined, true).scanFile("malicious.txt", Buffer.from("hi")))
            .toMatchObject({safe: false, scanned: true});
    });
});
