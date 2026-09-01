#import <Foundation/Foundation.h>

@implementation NSProcessInfo (EveRenderCompatibility)
- (NSProcessInfoThermalState)thermalState {
  return NSProcessInfoThermalStateNominal;
}
@end
