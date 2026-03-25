import { SetMetadata } from '@nestjs/common';
import { RequiredRoles } from '../guards/rbac.guard';

export const Roles = (resource: string, action: string) => SetMetadata('roles', { resource, action });
