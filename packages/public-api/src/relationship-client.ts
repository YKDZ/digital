import {
  applyEntityIdentityMergeRequestSchema,
  applyRelationshipChangeRequestSchema,
  createRelatedEntityRequestSchema,
  entityIdentityMergeRequestSchema,
  entityMentionIdRequestSchema,
  listRelatedEntitiesRequestSchema,
  publicEntityIdentityMergePreviewSchema,
  publicEntityMentionResolutionSchema,
  publicRelatedEntityIdentitySchema,
  relatedEntityIdRequestSchema,
  relatedEntityIdentityListSchema,
  relatedEntityInspectionSchema,
  relationshipChangePreviewSchema,
  relationshipChangeRequestSchema,
  relationshipStatusSchema,
  relationshipTypeDefinitionListSchema,
  resolveEntityMentionRequestSchema,
  retractEntityMentionRequestSchema,
  undoEntityIdentityMergeRequestSchema,
  type ApplyEntityIdentityMergeRequest,
  type CreateRelatedEntityRequest,
  type EntityIdentityMergeRequest,
  type PublicEntityIdentityMergePreview,
  type PublicEntityMentionResolution,
  type PublicRelatedEntityIdentity,
  type PublicRelatedEntityInspection,
  type PublicRelationshipChange,
  type PublicRelationshipChangePreview,
  type PublicRelationshipTypeDefinition,
  type ResolveEntityMentionRequest,
  type RetractEntityMentionRequest,
} from "./contract.ts";
import type {
  PublicApiJsonRequest,
  PublicApiJsonRequestOptions,
  PublicApiRequestValidation,
} from "./source-connection-client.ts";

export type PublicRelationshipClientMethods = {
  listRelationshipTypeDefinitions(): Promise<
    readonly PublicRelationshipTypeDefinition[]
  >;
  findRelatedEntities(
    label: string,
  ): Promise<readonly PublicRelatedEntityIdentity[]>;
  inspectRelatedEntity(
    entityId: string,
  ): Promise<PublicRelatedEntityInspection>;
  createLocalRelatedEntity(
    input: CreateRelatedEntityRequest,
  ): Promise<PublicRelatedEntityIdentity>;
  previewRelationshipChange(input: {
    readonly changes: readonly PublicRelationshipChange[];
  }): Promise<PublicRelationshipChangePreview>;
  applyRelationshipChange(input: {
    readonly actorId: string;
    readonly preview: PublicRelationshipChangePreview;
  }): Promise<{ readonly status: "applied" }>;
  inspectEntityMentionResolution(
    mentionId: string,
  ): Promise<PublicEntityMentionResolution>;
  resolveEntityMentionManually(
    input: ResolveEntityMentionRequest & { readonly mentionId: string },
  ): Promise<{ readonly status: "applied" }>;
  retractEntityMentionResolution(
    input: RetractEntityMentionRequest & { readonly mentionId: string },
  ): Promise<{ readonly status: "applied" }>;
  previewEntityIdentityMerge(
    input: EntityIdentityMergeRequest,
  ): Promise<PublicEntityIdentityMergePreview>;
  applyEntityIdentityMerge(
    input: ApplyEntityIdentityMergeRequest,
  ): Promise<{ readonly status: "applied" }>;
  undoEntityIdentityMerge(
    input: ApplyEntityIdentityMergeRequest,
  ): Promise<{ readonly status: "applied" }>;
};

/** 将关系、指称和身份修复接入唯一公共产品客户端。 */
export function relationshipClientMethods(input: {
  readonly apiBaseUrl: URL;
  readonly requestJson: PublicApiJsonRequest;
  readonly validateRequest: PublicApiRequestValidation;
  readonly jsonRequest: PublicApiJsonRequestOptions;
}): PublicRelationshipClientMethods {
  return {
    async listRelationshipTypeDefinitions() {
      return await input.requestJson(
        new URL("relationships/types", input.apiBaseUrl),
        { headers: { accept: "application/json" } },
        relationshipTypeDefinitionListSchema,
      );
    },
    async findRelatedEntities(label) {
      const request = input.validateRequest(
        listRelatedEntitiesRequestSchema,
        { label },
        "关联实体查询条件无效",
      );
      const url = new URL("relationships/entities", input.apiBaseUrl);
      url.searchParams.set("label", request.label);
      return await input.requestJson(
        url,
        { headers: { accept: "application/json" } },
        relatedEntityIdentityListSchema,
      );
    },
    async inspectRelatedEntity(entityId) {
      const request = input.validateRequest(
        relatedEntityIdRequestSchema,
        { entityId },
        "关联实体编号无效",
      );
      return await input.requestJson(
        new URL(
          `relationships/entities/${encodeURIComponent(request.entityId)}`,
          input.apiBaseUrl,
        ),
        { headers: { accept: "application/json" } },
        relatedEntityInspectionSchema,
      );
    },
    async createLocalRelatedEntity(request) {
      const body = input.validateRequest(
        createRelatedEntityRequestSchema,
        request,
        "本地关联实体信息无效",
      );
      return await input.requestJson(
        new URL("relationships/entities", input.apiBaseUrl),
        input.jsonRequest("POST", body),
        publicRelatedEntityIdentitySchema,
      );
    },
    async previewRelationshipChange(request) {
      const body = input.validateRequest(
        relationshipChangeRequestSchema,
        request,
        "关系修改无效",
      );
      return await input.requestJson(
        new URL("relationships/preview", input.apiBaseUrl),
        input.jsonRequest("POST", body),
        relationshipChangePreviewSchema,
      );
    },
    async applyRelationshipChange(request) {
      const body = input.validateRequest(
        applyRelationshipChangeRequestSchema,
        request,
        "关系修改无效",
      );
      return await input.requestJson(
        new URL("relationships/apply", input.apiBaseUrl),
        input.jsonRequest("POST", body),
        relationshipStatusSchema,
      );
    },
    async inspectEntityMentionResolution(mentionId) {
      const request = input.validateRequest(
        entityMentionIdRequestSchema,
        { mentionId },
        "实体指称编号无效",
      );
      return await input.requestJson(
        entityMentionResolutionUrl(request.mentionId, input.apiBaseUrl),
        { headers: { accept: "application/json" } },
        publicEntityMentionResolutionSchema,
      );
    },
    async resolveEntityMentionManually(request) {
      const { mentionId, ...requestBody } = request;
      const id = input.validateRequest(
        entityMentionIdRequestSchema,
        { mentionId },
        "实体指称编号无效",
      );
      const body = input.validateRequest(
        resolveEntityMentionRequestSchema,
        requestBody,
        "实体指称解析信息无效",
      );
      return await input.requestJson(
        entityMentionResolutionUrl(id.mentionId, input.apiBaseUrl),
        input.jsonRequest("POST", body),
        relationshipStatusSchema,
      );
    },
    async retractEntityMentionResolution(request) {
      const { mentionId, ...requestBody } = request;
      const id = input.validateRequest(
        entityMentionIdRequestSchema,
        { mentionId },
        "实体指称编号无效",
      );
      const body = input.validateRequest(
        retractEntityMentionRequestSchema,
        requestBody,
        "实体指称撤回信息无效",
      );
      return await input.requestJson(
        entityMentionResolutionUrl(id.mentionId, input.apiBaseUrl),
        input.jsonRequest("DELETE", body),
        relationshipStatusSchema,
      );
    },
    async previewEntityIdentityMerge(request) {
      const body = input.validateRequest(
        entityIdentityMergeRequestSchema,
        request,
        "身份合并信息无效",
      );
      return await input.requestJson(
        new URL("identity/preview", input.apiBaseUrl),
        input.jsonRequest("POST", body),
        publicEntityIdentityMergePreviewSchema,
      );
    },
    async applyEntityIdentityMerge(request) {
      const body = input.validateRequest(
        applyEntityIdentityMergeRequestSchema,
        request,
        "身份合并信息无效",
      );
      return await input.requestJson(
        new URL("identity/apply", input.apiBaseUrl),
        input.jsonRequest("POST", body),
        relationshipStatusSchema,
      );
    },
    async undoEntityIdentityMerge(request) {
      const body = input.validateRequest(
        undoEntityIdentityMergeRequestSchema,
        request,
        "身份合并撤销信息无效",
      );
      return await input.requestJson(
        new URL("identity/undo", input.apiBaseUrl),
        input.jsonRequest("POST", body),
        relationshipStatusSchema,
      );
    },
  };
}

function entityMentionResolutionUrl(mentionId: string, baseUrl: URL): URL {
  return new URL(
    `entity-mentions/${encodeURIComponent(mentionId)}/resolution`,
    baseUrl,
  );
}
