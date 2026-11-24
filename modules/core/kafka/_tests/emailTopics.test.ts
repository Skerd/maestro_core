/**
 * D188: each email kind has its own Kafka topic, named after its env key; a module's topics are required at boot while
 * Kafka is on; a stopping server waits for the emails its committed work queued.
 */
import {describe, expect, it} from "vitest";
import {emailTopicSpec} from "@coreModule/kafka/kafkaConsumer";
import {emailEventType} from "@coreModule/kafka/kafkaProducer";
import {kafkaTopicErrors, type ModuleEnvironmentContext} from "@coreModule/environment/validator";
import {keepUntilSettled, settleAfterCommitWork} from "@coreModule/utilities/middlewares/transactionUtils";

const kafka = {
    TOPICS: {RENTAL_HANDED_OVER_EMAIL: "rental-handed-over-email"},
    CONSUMER_GROUP: {RENTAL_HANDED_OVER_EMAIL: "rental-handed-over-email-consumer-group"},
};

const ctx = (env: NodeJS.ProcessEnv, kafkaEnabled: boolean): ModuleEnvironmentContext => ({
    env,
    kafkaEnabled,
    validateString: (key, value, required = true) => (required && !value ? {key, message: `${key} missing`} : null),
    validateNumber: () => null,
    validateBoolean: () => null,
    validateArray: () => null,
});

describe("an email kind's own topic (D188)", () => {
    it("names its consumer, label and event type after the env key", () => {
        const handle = async () => undefined;
        expect(emailTopicSpec(kafka, "RENTAL_HANDED_OVER_EMAIL", handle)).toEqual({
            registryKey: "rentalHandedOverEmail",
            displayName: "Rental handed over email",
            groupId: "rental-handed-over-email-consumer-group",
            topic: "rental-handed-over-email",
            expectedEventType: "rental_handed_over_email",
            processEvent: handle,
        });
        expect(emailEventType("RENTAL_HANDED_OVER_EMAIL")).toBe("rental_handed_over_email");
    });

    it("requires a module's topic and group while Kafka is on, and nothing while it is off", () => {
        expect(kafkaTopicErrors(ctx({}, true), kafka).map((error) => error.key)).toEqual([
            "KAFKA_TOPIC_RENTAL_HANDED_OVER_EMAIL",
            "KAFKA_CONSUMER_GROUP_RENTAL_HANDED_OVER_EMAIL",
        ]);
        expect(kafkaTopicErrors(ctx({
            KAFKA_TOPIC_RENTAL_HANDED_OVER_EMAIL: "t",
            KAFKA_CONSUMER_GROUP_RENTAL_HANDED_OVER_EMAIL: "g",
        }, true), kafka)).toEqual([]);
        expect(kafkaTopicErrors(ctx({}, false), kafka)).toEqual([]);
    });
});

describe("a stopping server (D188)", () => {
    it("waits for after-commit work that is still running", async () => {
        let sent = false;
        keepUntilSettled(new Promise<void>((resolve) => setTimeout(() => {
            sent = true;
            resolve();
        }, 20)));
        await settleAfterCommitWork(1000);
        expect(sent).toBe(true);
    });

    it("stops waiting at its limit", async () => {
        keepUntilSettled(new Promise<void>(() => undefined));
        const started = Date.now();
        await settleAfterCommitWork(30);
        expect(Date.now() - started).toBeLessThan(1000);
    });
});
