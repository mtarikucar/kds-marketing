import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/**
 * OpenAPI/Swagger docs (Documentation).
 *
 * Served at `/api/docs` (UI) and `/api/docs-json` (spec). The `@nestjs/swagger`
 * CLI plugin (nest-cli.json) introspects the class-validator DTOs, so request
 * schemas are documented without hand-written `@ApiProperty` on every field.
 *
 * All four credential schemes are registered so the "Authorize" button can
 * exercise each realm: the two human bearer realms (marketing / platform) and
 * the service header tokens (internal / research / ingest).
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('KDS Marketing API')
    .setDescription(
      'Multi-tenant AI lead-generation platform — workspace, platform-operator, and service-to-service surfaces.',
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'marketing',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'platform',
    )
    .addApiKey({ type: 'apiKey', name: 'x-internal-token', in: 'header' }, 'internal-token')
    .addApiKey({ type: 'apiKey', name: 'x-research-token', in: 'header' }, 'research-token')
    .addApiKey({ type: 'apiKey', name: 'x-ingest-token', in: 'header' }, 'ingest-token')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    swaggerOptions: { persistAuthorization: true },
  });
}
